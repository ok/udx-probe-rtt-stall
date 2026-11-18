// The sender of pair.js with --work, reading the stream's internal state straight from its native
// structure about once a millisecond into a ring. When BBR's minimum round-trip estimate drops to
// 2 ms or less the ring is printed, so the lines show what led up to it.
//
// Start link.js and `pair.js recv` first (see the README), then: node inspect/inspect-send.js
//
// The field offsets are those of udx_stream_t in libudx 9c9a0e7 on darwin-arm64, as printed by
// offsets.c; six of them are also exported by udx-native's binding and agree. For another
// platform or version, build offsets.c against that libudx's headers and pass OFFSETS=<file>.
const UDX = require('udx-native')
const O = require(process.env.OFFSETS || './offsets-darwin-arm64.json')
const workMs = Number(process.env.WORK || 1.3)
const total = Number(process.env.BYTES || 1.2e9)
const frameBytes = 65536
const udx = new UDX()
const socket = udx.createSocket()
socket.bind(41000)
const stream = udx.createStream(1)
stream.connect(socket, 2, 41010, '127.0.0.1')
const h = stream._handle
const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
const u8 = (k) => dv.getUint8(O[k]); const u16 = (k) => dv.getUint16(O[k], true); const u32 = (k) => dv.getUint32(O[k], true)
const u64 = (k) => Number(dv.getBigUint64(O[k], true))
const t0 = performance.now()
function snap() {
  const mtu = u16('mtu')
  return {
    t: +(performance.now() - t0).toFixed(1), st: u8('bbr.state'), cwnd: u32('cwnd'), infl: Math.round(u64('inflight') / mtu),
    minRtt: u32('bbr.min_rtt_ms'), srtt: u32('srtt'), rack: u32('rack_rtt'), rttMin: [0, 1, 2].map((i) => dv.getUint32(O.rtt_min + 16 * i + 8, true)).join('/'),
    deliv: u32('delivered'), seq: u32('seq'), acked: u32('remote_acked'), retx: u16('retransmit_count'), fr: u16('fast_recovery_count'), rto: u8('rto_count'),
    timer: u32('pending_timer'), tlp: `${u8('tlp_in_flight')}${u8('tlp_is_retrans')}${u8('tlp_permitted')}`, appLim: u32('app_limited'),
    prDone: u64('bbr.probe_rtt_done_time') ? 1 : 0, idle: u8('bbr.idle_restart'), bw0: +(dv.getFloat64(O['bbr.bw'] + 8, true) * mtu / 1000).toFixed(1),
  }
}
const ring = []
let lastMin = null; let dumps = 0; let after = 0
function sample() {
  const s = snap()
  const prev = ring[ring.length - 1]
  if (!prev || prev.deliv !== s.deliv || prev.st !== s.st || prev.minRtt !== s.minRtt || prev.retx !== s.retx || prev.timer !== s.timer) ring.push(s)
  if (ring.length > 60) ring.shift()
  if (after > 0 && --after === 0) { for (const r of ring.slice(-25)) console.log('  +', JSON.stringify(r)) }
  if (lastMin !== null && s.minRtt < lastMin && s.minRtt <= 2 && dumps < 3) {
    dumps++
    console.log(`--- min rtt ${lastMin} -> ${s.minRtt} at ${s.t} ms`)
    for (const r of ring) console.log('   ', JSON.stringify(r))
    after = 40
  }
  lastMin = s.minRtt
}
let moved = 0
const frame = Buffer.alloc(frameBytes, 0x5a)
function work() { const until = performance.now() + workMs; while (performance.now() < until) { sample() } }
const pump = () => {
  while (moved < total) {
    moved += frameBytes; work()
    if (!stream.write(frame)) return stream.once('drain', pump)
  }
  stream.end()
}
setInterval(sample, 1).unref()
stream.on('finish', () => { stream.destroy(); socket.close() })
stream.on('error', () => process.exit(0))
stream.resume(); pump()
