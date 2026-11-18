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

## The same minimum, on a short path over a hop that delivers in bursts

The minimum round trip is a whole number of milliseconds. On a path whose true round trip is
about 2 ms it reads as 1 or 2 from one ten-second window to the next, and BBR sizes its window
as `gain * bw * min_rtt`, so with 1 the window is half as large. Over a wired path that does not
matter. Over a hop that delivers in bursts, as Wi-Fi does when it aggregates frames, the round
trip under load is several milliseconds, a window sized for 1 ms cannot keep the hop full, the
delivery rate falls and the bandwidth estimate follows it. The stream then runs at a quarter to
a half of its rate until a later `PROBE_RTT` reads 2.

`link.js --txop <ms>` emulates such a hop: both directions share one medium that carries one
aggregate at a time, up to that much airtime, and everything in an aggregate arrives together.

```
node run-local.js --bytes 3000000000 --delay 0.7 --txop 4
```

The window calculation's inputs, printed once a second from an instrumented build on that hop:

```
min_rtt_ms 2  bdp 129  aggr  98  cwnd 227     (full rate)
min_rtt_ms 1  bdp  51  aggr  50  cwnd 101     (slow, for the whole ten-second window)
```

### A change that removes both

> **Later finding: this patch is not a fix as it stands.** The figures in this section are from
> runs of 25 to 100 seconds. On a 12 GB run over the same Wi-Fi in the other direction, libudx
> main with this patch on both ends averaged 21.8 MB/s (median 9.9) against 36.0 MB/s (median
> 40.7) for udx-native 1.22.1. There the unloaded round trip is about 1.4 ms and the loaded one
> 3 ms or more, so a window of `2 * bw * min_rtt` with the exact minimum holds less than one
> loaded round trip and the rate shrinks; rounding 1.4 ms up to 2 ms, as the released library
> does, happens to leave enough room. The same run also showed bandwidth samples of several times
> the link rate right after `PROBE_RTT`, followed by a burst and loss. The whole-millisecond
> minimum is still the cause of the slow state described above, but a finer minimum alone trades
> one failure for another on such paths.


`libudx-microsecond-min-rtt.patch` (13 lines added, 6 removed; applies to libudx 9c9a0e7 and to
main at e384532) records a packet's send time from `uv_hrtime()` as well, takes the round-trip
sample for BBR in microseconds from a fresh reading when the acknowledgement is processed, and
sizes the window from `min_rtt_us`. RACK, the retransmission timer and the rate sampler keep the
millisecond clock. Because the sample no longer comes from the cached clock, the stall described
above goes with it.

Single stream, no encryption, udx-native 1.22.1 built from source, Apple M4:

| Path | libudx 9c9a0e7 | with the patch |
|---|---|---|
| Wi-Fi 802.11ax 80 MHz, laptop to a wired machine, 4 GB, pair A | 41.1 MB/s | 47.8 MB/s |
| the same, pair B (stock, patched, stock, patched within ten minutes) | 30.5 MB/s | 48.0 MB/s |
| `--delay 0.7 --txop 4` | 32.4 to 35.0 MB/s | 39.8 MB/s |
| `--delay 0.7 --txop 4`, libudx main e384532 | 35.6 MB/s | 41.5 MB/s |
| control (400 Mbit/s, 10 ms) | 49.3 MB/s | 49.3 MB/s |
| `--send-work 1.3` | 18 of 49 s stalled | 0 of 48 s stalled |

With `PROBE_RTT` disabled the emulated hop carries 43.8 MB/s, but the minimum then drifts up with
the queue and the hop drops packets, so that figure is a ceiling, not an alternative.

`FINE=5 FINE_OUT=fine.txt` on a run samples the sender every 5 ms; `python3 episodes.py fine.txt`
reports what each `PROBE_RTT` episode cost. On the Wi-Fi path an episode was followed by ten slow
seconds about one time in five with libudx 9c9a0e7.

Not covered: Windows or Linux as the sender, libudx's own test suite, and the rate sampler, which
still measures its intervals in milliseconds.

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
| `libudx-microsecond-min-rtt.patch` | the change that removes the stall and the slow state on a bursting hop |
| `episodes.py` | reads a `FINE` sample file and reports each `PROBE_RTT` episode |
| `inspect/` | a sender that logs the stream's internal state around the drop, with the field offsets it reads |

`pair.js` also runs across two machines without `link.js`: start `recv` on one and `send` on the
other, each with the other's address as `--peer`.
