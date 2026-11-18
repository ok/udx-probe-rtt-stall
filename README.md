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
node run-local.js --send-work 1.3      # stalls
node run-local.js                      # control: does not stall
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

So the condition is a busy sending thread. A sender that is merely slower than the path, but
idle between its writes, does not stall, and neither does a busy receiver.

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

A stalled block starts every ten seconds, the interval at which BBR's minimum round-trip filter
expires and the stream enters `PROBE_RTT` (`UDX_BBR_MIN_RTT_INTERVAL_MS`, `src/udx_bbr.c` in libudx). In the control run
the same moment costs one slower second (about 38 instead of 49 MB/s) and the stream carries on.
With a busy sending thread the window and the bandwidth estimate stay at the floor for the next
ten seconds, until the following probe.

## Where it was first seen

Between two wired Macs at different sites, 11 ms apart, sending one large file through an
encrypted, multiplexed connection on a stream opened by hyperdht. Every transfer alternated
between about 45 MB/s and about 0.6 MB/s in ten-second blocks, with the sending worker's thread
at 99.5 % of a core while moving. Between a fifth and a third of each transfer was spent stalled.
The figures read off the stream during a stalled block there are the ones this reproduction
shows.

## Not established

- Why the estimate does not recover after the probe ends. The reproduction shows that it does
  not; the cause inside the congestion control has not been traced.
- Whether a busy thread is the only trigger.

## Files

| File | What |
|---|---|
| `pair.js` | one end of a bare udx stream: `send` or `recv`, prints once a second |
| `link.js` | the emulated path: rate, delay and queue between two UDP ports |
| `run-local.js` | starts all three and counts the stalled seconds |

`pair.js` also runs across two machines without `link.js`: start `recv` on one and `send` on the
other, each with the other's address as `--peer`.
