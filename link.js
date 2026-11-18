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

const socketA = dgram.createSocket('udp4')
const socketB = dgram.createSocket('udp4')
const toB = direction(socketB, b)
const toA = direction(socketA, a)
socketA.on('message', (packet) => toB.accept(packet))
socketB.on('message', (packet) => toA.accept(packet))
socketA.bind(a.listen)
socketB.bind(b.listen)
process.on('SIGTERM', () => {
  console.log(`link: dropped ${toB.dropped} packets towards B, ${toA.dropped} towards A`)
  process.exit(0)
})
