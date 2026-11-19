# udx stream stalls for ten seconds at a time when the sending thread is busy

A bulk send over a single `udx-native` stream alternates between full speed and almost nothing,
in blocks of about ten seconds, when the application does work on the thread the stream runs on.
Nothing is lost during a stalled block and no timeout fires: the stream's congestion window sits
at 4 to 7 packets and its bandwidth estimate at well under 1 MB/s until the block ends.

This repository reproduces it on one machine with nothing above the transport: no encryption, no
multiplexing, no DHT.

## Run it

```
npm install
node run-local.js --send-work 1.3            # stalls
node run-local.js                            # control: does not stall
node run-local.js --send-work 1.3 --defer    # same work, outside the receive path: does not stall
```

`run-local.js` starts three processes: a sender, a receiver, and a link between them that
emulates a path (400 Mbit/s bottleneck, 5 ms each way, 1.5 MB queue, tail drop). It prints the
sender's figures once a second and, at the end, how many seconds ran below a tenth of the typical
rate.

`--send-work <ms>` makes the sender spend that long on its own thread for every 64 KiB it writes,
the way an application does that encrypts or reads what it sends. At 1.3 ms the sender can supply
about 41 MB/s, a little less than the link carries.

## What it shows

udx-native 1.22.1, Node 24.19.0, macOS 27.2.1, Apple M4, 1.2 GB per run.

| Run | Average | Typical second | Stalled seconds |
|---|---|---|---|
| `node run-local.js` | 47.9 MB/s | 49.2 MB/s | 0 of 31 |
| `--supply 40` (sender idle between writes, 40 MB/s) | 39.6 MB/s | 40.0 MB/s | 0 of 30 |
| `--recv-work 1.3` (receiver's thread busy) | 40.5 MB/s | 41.2 MB/s | 0 of 29 |
| `--send-work 1.3` (sender's thread busy) | 24.0 MB/s | 40.0 MB/s | 18 of 49 |
| `--send-work 1.3`, again | 23.9 MB/s | 39.1 MB/s | 19 of 50 |
| `--send-work 1.3`, again | 24.2 MB/s | 41.1 MB/s | 19 of 49 |

So the condition is a sending thread that is busy inside the stream's callbacks. A sender that
is merely slower than the path, but idle between its writes, does not stall, and neither does a
busy receiver.

Seconds 8 to 24 of a stalling run:

```
   8s send   41.3 MB/s  cwnd   645  inflight   910404  rtt   18  bbr state 2 bw   45.6 MB/s retransmits 0  rto 0
   9s send   41.9 MB/s  cwnd   645  inflight   936540  rtt   17  bbr state 2 bw   45.9 MB/s retransmits 0  rto 0
  10s send   41.8 MB/s  cwnd   667  inflight   965580  rtt   18  bbr state 2 bw   45.5 MB/s retransmits 0  rto 0
  11s send    8.7 MB/s  cwnd    12  inflight    17424  rtt    8  bbr state 2 bw    2.4 MB/s retransmits 0  rto 0
  12s send    0.7 MB/s  cwnd     4  inflight     5808  rtt    8  bbr state 2 bw    0.6 MB/s retransmits 0  rto 0
  13s send    0.7 MB/s  cwnd     4  inflight     5808  rtt    8  bbr state 2 bw    0.6 MB/s retransmits 0  rto 0
  14s send    0.6 MB/s  cwnd     5  inflight     7260  rtt    8  bbr state 2 bw    1.0 MB/s retransmits 0  rto 0
  15s send    0.7 MB/s  cwnd     4  inflight     5808  rtt    8  bbr state 2 bw    0.6 MB/s retransmits 0  rto 0
  16s send    0.6 MB/s  cwnd     5  inflight     7260  rtt    8  bbr state 2 bw    0.7 MB/s retransmits 0  rto 0
  17s send    0.7 MB/s  cwnd     4  inflight     5808  rtt    8  bbr state 2 bw    0.6 MB/s retransmits 0  rto 0
  18s send    0.7 MB/s  cwnd     4  inflight     5808  rtt    8  bbr state 2 bw    1.1 MB/s retransmits 0  rto 0
  19s send    0.7 MB/s  cwnd     4  inflight     5808  rtt    8  bbr state 2 bw    0.6 MB/s retransmits 0  rto 0
  20s send    0.7 MB/s  cwnd     6  inflight     8712  rtt    8  bbr state 2 bw    0.9 MB/s retransmits 0  rto 0
  21s send   12.3 MB/s  cwnd   608  inflight   882816  rtt   14  bbr state 2 bw   45.8 MB/s retransmits 0  rto 0
  22s send   41.9 MB/s  cwnd   588  inflight   853776  rtt   15  bbr state 2 bw   43.9 MB/s retransmits 0  rto 0
  23s send   41.9 MB/s  cwnd   577  inflight   756492  rtt   15  bbr state 2 bw   45.7 MB/s retransmits 0  rto 0
  24s send   41.9 MB/s  cwnd   582  inflight   772464  rtt   15  bbr state 2 bw   43.3 MB/s retransmits 0  rto 0
```

## Cause

The stream measures a round trip as the difference between two readings of the event loop's
cached clock: `pkt->time_sent = uv_now(loop)` when a packet is sent and `uv_now(loop)` again when
its acknowledgement is processed (`_send_packet` and `ack_packet` in libudx `src/udx.c`). libuv
refreshes that clock once per loop iteration. It reads up to 32 datagrams per iteration from a
readable socket, and an application callback can run between two of them: processing an
acknowledgement makes the stream writable, `drain` fires, and the application writes.

If those callbacks together take longer than the path's round trip, packets sent in them are
acknowledged within the same iteration, by datagrams that arrived while the application was
working. Both readings of the clock are then the same and the sample is 0 ms, recorded as 1 ms.

BBR takes any sample below its minimum as the new minimum round trip. With 1 ms in place of
10 ms the bandwidth-delay product is a tenth of what it should be, the congestion window is cut
to match, the stream becomes window-limited, each delivery-rate sample is lower than the last,
and window and bandwidth estimate fall together to the floor of 4 packets. Nothing corrects the
1 ms until the minimum's ten-second window expires and the next `PROBE_RTT` measures the path
again, which is why a stalled block lasts ten seconds.

It happens at the end of `PROBE_RTT` because that is when the window jumps from 4 packets back
to several hundred and the application, which has been waiting, writes a large burst at once.

What the stream's own structure shows at that moment (`inspect/inspect-send.js`; time in ms,
window and delivered in packets):

```
t 10241.2  PROBE_RTT  cwnd   4  min_rtt  8  srtt  9  delivered 290176  next seq 290180
t 10249.8  PROBE_BW   cwnd 516  min_rtt  8  srtt  9  delivered 290177  next seq 290402
t 10264.8  PROBE_BW   cwnd  96  min_rtt  1  srtt  1  delivered 290209  next seq 290435
```

Between the second and third line the application worked for 15 ms. Then 32 acknowledgements,
one read batch, were processed with the clock still at the value the packets were stamped with:
the smoothed round trip fell from 9 ms to 1 ms and the minimum with it.

### The test that confirms it

`--defer` makes the sender continue writing on a later turn of the event loop instead of inside
the `drain` callback. It does the same work and its thread is as busy as before, but it no
longer works between two datagrams of one read batch:

| Run | Average | Stalled seconds |
|---|---|---|
| `--send-work 1.3` | 24.2 MB/s | 19 of 49 |
| `--send-work 1.3 --slice 4` (no burst of work longer than 4 ms) | 24.2 MB/s | 19 of 49 |
| `--send-work 1.3 --defer` | 40.1 MB/s | 0 of 29 |
| `--send-work 1.3 --slice 4 --defer` | 41.0 MB/s | 0 of 29 |

Shortening each burst of work does not help, because every acknowledgement in the batch can
start another one. Moving the work out of the receive path removes the stall.

### A fix that removes it

`libudx-current-clock.patch` (against libudx 9c9a0e7, six lines) refreshes the loop's clock with
`uv_update_time` before a packet is stamped and before an incoming datagram is processed, so
both readings are current. udx-native 1.22.1 built from source with and without it, same machine:

| Run | libudx 9c9a0e7 | with the patch |
|---|---|---|
| `--send-work 1.3` | 24.2 MB/s, 19 of 49 s stalled | 39.7 MB/s, 0 of 30 |
| `--send-work 1.3`, again | | 38.9 MB/s, 0 of 30 |
| `--send-work 2.6` | | 21.8 MB/s, 0 of 55 |
| control | 47.9 MB/s, 0 of 31 | 47.9 MB/s, 0 of 25 |

To compare a build of your own: `UDX_NATIVE=/path/to/udx-native node run-local.js --send-work 1.3`.

The patch costs one clock read per packet sent and per datagram received. libudx's own test suite
was not run against it, and it has not been tried on Linux or Windows.

## Open pull requests on libudx, measured against this

Each applied on its own to libudx 9c9a0e7 and run with `--send-work 1.3`, twice:

| Pull request | Result |
|---|---|
| [#334](https://github.com/holepunchto/libudx/pull/334) "Fix/fresh rtt sample" (draft) | 40.7 and 41.0 MB/s, 0 seconds stalled |
| [#332](https://github.com/holepunchto/libudx/pull/332) "generate 1 rtt sample per ACK" | 23.9 and 24.1 MB/s, 19 and 18 seconds stalled |

#334 addresses this mechanism directly: it times an acknowledgement with a clock read when the
datagram is processed, not with the loop's cached time, and its test is named for a long callback
in the same wakeup. It removes the stall here. #332 changes how many samples an acknowledgement
yields, not where their time comes from, and leaves the stall as it is.

## Two changes on libudx main, measured

Both are on https://github.com/ok/libudx, each on its own on libudx main (fb2d472) and together.
Every commit carries a unit test; libudx's suite passes on each branch.

| Branch | Change |
|---|---|
| [`proposal/min-rtt-us`](https://github.com/ok/libudx/commits/proposal/min-rtt-us) | BBR's round-trip sample comes from a fresh `uv_hrtime()` reading, in microseconds, and the window is sized from `min_rtt_us`. RACK, the retransmission timer and the rate sampler keep the millisecond clock. |
| [`proposal/window-budget`](https://github.com/ok/libudx/commits/proposal/window-budget) | `bbr_bdp` rounds up and the window target gets a quantization budget of three send quanta, as Linux BBRv1 does. |
| [`proposal/combined`](https://github.com/ok/libudx/commits/proposal/combined) | both: the window budget first, the fresh sample on top |

### The stall (this repository's reproduction)

`node run-local.js --send-work 1.3`, 2 GB, two runs each, seconds below a tenth of the typical rate:

| libudx | Run 1 | Run 2 | Control without `--send-work` |
|---|---|---|---|
| 9c9a0e7 (udx-native 1.22.x) | 37 of 90 | 37 of 90 | 49 MB/s, none |
| main fb2d472 | 38 of 90 | 29 of 82 | 49 MB/s, none |
| main + `min-rtt-us` | 0 of 49 | 0 of 50 | 49 MB/s, none |
| main + `window-budget` | 20 of 86 | 20 of 77 | 49 MB/s, none |
| main + both | 0 of 50 | 5 of 59 | 49 MB/s, none |

The fresh sample removes the stall; the window budget does not, and is not meant to. But the fresh
sample must not be applied alone: see the Linux sender below.

### A Wi-Fi link

A wired Windows machine sends to a laptop on 802.11ax, 5 GHz, 80 MHz, link rate 650 to 865 Mbit/s.
One stream, no encryption, 8 to 12 GB per run, runs back to back in mixed order on one morning.
A slow stretch is four seconds or more below 60 % of the run's median.

| libudx (both ends) | Runs, MB/s | Slow stretches per run | Packets resent |
|---|---|---|---|
| 9c9a0e7 (udx-native 1.22.x) | 39.7, 41.5 | 5, 3 | 0.04 to 0.09 % |
| main fb2d472 | 53.8, 51.7, 51.4, 55.4, 51.3, 55.9, 56.2 | 1, 2, 1, 0, 1, 0, 0 | 0.005 to 0.11 % |
| main + `window-budget` | 55.5, 59.7, 58.3 | none | 0.1 to 0.23 % |
| main + both | 57.9, 57.0, 60.7, 60.2, 60.1, 59.2 | none | 0.04 to 0.23 % |

The slow stretches start and end on a `PROBE_RTT`, with the window at 100 to 200 packets where it
is 700 to 1000 otherwise: the target `2 * bw * min_rtt` holds less than one loaded round trip on
this link, the delivery rate falls, and the bandwidth filter follows it until the next probe.

Inside an application (encrypted, multiplexed, 20 GB file, same link): 42.1 MB/s with udx-native
1.22.x and four slow stretches; 56.0 MB/s with main + both and none.

### Other senders and paths

A wired Linux machine (Arch, kernel 7.2, Ryzen) sends to the same laptop on Wi-Fi, 8 GB per run,
two rounds in mixed order. The access point's radio was hot in several of these runs (it exceeded
105 °C in most of round 2), so compare builds, not levels.

| libudx, both ends | Runs, MB/s | Window, median packets |
|---|---|---|
| 9c9a0e7 (udx-native 1.22.x) | 24.1, 29.0 | 108, 134 |
| main fb2d472 | 39.7, 45.0 | 253, 327 |
| main + `min-rtt-us` only | **9.8, 10.5** | 15, 16 |
| main + `window-budget` | 55.7, 54.9 | 644, 717 |
| main + both | 51.7, 52.4 | 451, 453 |

**`min-rtt-us` on its own makes this path much worse.** The run starts at 30 to 35 MB/s and
within half a minute the window sits at 7 to 16 packets. With an exact minimum of well under
2 ms, `2 * bw * min_rtt` is smaller than with the minimum rounded up to a whole millisecond, and
the shrinking described above sets in for good. With the window budget underneath it does not.
So the fresh sample belongs on top of the window budget, never alone;
`proposal/combined` has them in that order.

Both machines on the Wi-Fi network (the Windows sender on 802.11ac, so every packet crosses the
air twice), 4 GB per run: 9c9a0e7 18.1, 17.0; main 21.7, 20.8, 20.6, 22.0; main + `min-rtt-us`
only 20.5, 21.5, 22.0; main + `window-budget` 24.0, 24.1; main + both 24.0, 24.2 MB/s.

Linux and Windows on gigabit Ethernet, 8 GB per run, two rounds:

| libudx, both ends | Linux to Windows, MB/s | Windows to Linux, MB/s |
|---|---|---|
| 9c9a0e7 (udx-native 1.22.x) | 110.0, 111.3 | 115.9, 115.9 |
| main fb2d472 | 103.9, 111.1 | 115.9, 115.8 |
| main + `min-rtt-us` only | 115.4, 115.4 | 115.8, 115.6 |
| main + `window-budget` | 112.2, 109.3 | 115.9, 115.9 |
| main + both | 107.0, 111.0 | 115.9, 115.9 |

All at the link's limit. Windows to Linux resent no packet in any run; Linux to Windows resent
0.03 to 1.1 % in every build, without a pattern by build.

### What is not shown

- An earlier version of this section reported that main + `min-rtt-us` collapsed on a long run
  over the Wi-Fi link with the Windows sender, and a later version withdrew that because the
  access point had been overheating during it. The Linux runs above show the same collapse with
  the radio cool, so the first report was probably right. It was not repeated with the Windows
  sender under controlled conditions.
- A real internet path. The stall figures are from the emulated one.
- macOS as a sender on the Wi-Fi link.
- Why the window budget resends more. The larger window puts more in flight when a queue
  overflows; whether that is all of it was not examined.

### The emulated hop that delivers in bursts

`link.js --txop <ms>` makes both directions share one medium that carries one aggregate at a
time, up to that much airtime, and everything in an aggregate arrives together:

```
node run-local.js --bytes 3000000000 --delay 0.7 --txop 4
```

`UDX_NATIVE=/path/to/udx-native` selects the library build. `FINE=5 FINE_OUT=fine.txt` samples the
sender every 5 ms; `python3 episodes.py fine.txt` reports what each `PROBE_RTT` episode cost.

## Where it was first seen

Between two wired Macs at different sites, 11 ms apart, sending one large file through an
encrypted, multiplexed connection on a stream opened by hyperdht. Every transfer alternated
between about 45 MB/s and about 0.6 MB/s in ten-second blocks, with the sending worker's thread
at 99.5 % of a core while moving. Between a fifth and a third of each transfer was spent stalled.
The figures read off the stream during a stalled block there are the ones this reproduction
shows.

## Not established

- Whether the same stale reading matters elsewhere in the stream: the retransmission timer, the
  loss probe and the reordering window are all derived from the same samples.
- How often it occurs in applications whose callbacks are shorter than the round trip. On a path
  with a longer round trip the same work would not trigger it.

## Files

| File | What |
|---|---|
| `pair.js` | one end of a bare udx stream: `send` or `recv`, prints once a second |
| `link.js` | the emulated path: rate, delay and queue between two UDP ports; `--txop` for a hop that delivers in bursts |
| `run-local.js` | starts all three and counts the stalled seconds |
| `libudx-current-clock.patch` | the first change to libudx measured above |
| `libudx-microsecond-min-rtt.patch` | an early form of `proposal/min-rtt-us`, against libudx 9c9a0e7 |
| `episodes.py` | reads a `FINE` sample file and reports each `PROBE_RTT` episode |
| `inspect/` | a sender that logs the stream's internal state around the drop, with the field offsets it reads |

`pair.js` also runs across two machines without `link.js`: start `recv` on one and `send` on the
other, each with the other's address as `--peer`.
