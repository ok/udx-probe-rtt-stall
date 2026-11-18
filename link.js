// A link between the two ends, on one machine: every packet from one end is forwarded to the
// other after passing a bottleneck of a fixed rate, with a fixed one-way delay and a bounded
// queue that drops from the tail when full. It stands in for an internet path so the stall can
// be shown without two sites.
//
//   node link.js --a 41010:127.0.0.1:41000 --b 41011:127.0.0.1:41001 --mbit 400 --delay 5 --queue 1500000
//
// End A sends to this link's port 41010 and is reached at 127.0.0.1:41000; likewise B.
const dgram = require('dgram')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i === -1 ? fallback : args[i + 1]
}
const side = (spec) => {
  const [listen, host, port] = String(spec).split(':')
  return { listen: Number(listen), host, port: Number(port) }
}
const a = side(opt('a'))
const b = side(opt('b'))
const bytesPerMs = (Number(opt('mbit', 400)) * 1e6) / 8 / 1000
const delayMs = Number(opt('delay', 5))
const queueBytes = Number(opt('queue', 1500000))

const nowMs = () => Number(process.hrtime.bigint()) / 1e6

// One direction: packets leave the bottleneck one after another at its rate, then travel for the
// delay. `clear` is when the bottleneck is free again; the queue is what is still waiting for it.
function direction(out, to) {
  const waiting = []
  let head = 0
  let clear = 0
  let dropped = 0
  let pumping = false
  function pump() {
    const now = nowMs()
    while (head < waiting.length && waiting[head].at <= now) {
      const { packet } = waiting[head++]
      out.send(packet, to.port, to.host)
    }
    if (head === waiting.length) {
      waiting.length = 0
      head = 0
      pumping = false
      return
    }
    setImmediate(pump)
  }
  return {
    get dropped() { return dropped },
    accept(packet) {
      const now = nowMs()
      if (clear < now) clear = now
      if ((clear - now) * bytesPerMs + packet.byteLength > queueBytes) { dropped++; return }
      clear += packet.byteLength / bytesPerMs
      waiting.push({ packet, at: clear + delayMs })
      if (!pumping) { pumping = true; setImmediate(pump) }
    },
  }
}

// With --txop the bottleneck behaves like a wireless hop: both directions share one medium, and
// it carries one aggregate at a time. An aggregate takes what is waiting in one direction, up to
// --txop ms of airtime, and everything in it arrives together when its airtime (plus --overhead ms
// for access and its acknowledgement) is over. A lone packet on an idle medium leaves at once;
// under load a packet waits for the aggregates ahead of it, also those of the other direction.
const txopMs = Number(opt('txop', 0))
const overheadMs = Number(opt('overhead', 0.2))
function medium(sides) {
  let busyUntil = 0
  let turn = 0
  let running = false
  const flights = []
  function step() {
    const now = nowMs()
    while (flights.length && flights[0].at <= now) {
      const f = flights.shift()
      for (const packet of f.packets) f.side.out.send(packet, f.side.to.port, f.side.to.host)
    }
    if (now >= busyUntil) {
      for (let n = 0; n < sides.length; n++) {
        const side = sides[(turn + n) % sides.length]
        if (side.head === side.waiting.length) continue
        const packets = []
        let bytes = 0
        while (side.head < side.waiting.length && (packets.length === 0 || bytes + side.waiting[side.head].byteLength <= txopMs * bytesPerMs)) {
          const packet = side.waiting[side.head++]
          bytes += packet.byteLength
          packets.push(packet)
        }
        side.queued -= bytes
        if (side.head === side.waiting.length) { side.waiting.length = 0; side.head = 0 }
        busyUntil = now + bytes / bytesPerMs + overheadMs
        flights.push({ at: busyUntil + delayMs, packets, side })
        turn = (turn + n + 1) % sides.length
        break
      }
    }
    if (flights.length || sides.some((side) => side.head < side.waiting.length)) setImmediate(step)
    else running = false
  }
  for (const side of sides) {
    side.waiting = []
    side.head = 0
    side.queued = 0
    side.dropped = 0
    side.accept = (packet) => {
      if (side.queued + packet.byteLength > queueBytes) { side.dropped++; return }
      side.queued += packet.byteLength
      side.waiting.push(packet)
      if (!running) { running = true; setImmediate(step) }
    }
  }
  return sides
}

const socketA = dgram.createSocket('udp4')
const socketB = dgram.createSocket('udp4')
const [toB, toA] = txopMs > 0
  ? medium([{ out: socketB, to: b }, { out: socketA, to: a }])
  : [direction(socketB, b), direction(socketA, a)]
socketA.on('message', (packet) => toB.accept(packet))
socketB.on('message', (packet) => toA.accept(packet))
socketA.bind(a.listen)
socketB.bind(b.listen)
process.on('SIGTERM', () => {
  console.log(`link: dropped ${toB.dropped} packets towards B, ${toA.dropped} towards A`)
  process.exit(0)
})
