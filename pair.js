// One end of a bare udx stream: no encryption, no multiplexing, nothing above the transport.
//
//   node pair.js recv --port 41001 --peer 127.0.0.1:41000
//   node pair.js send --port 41000 --peer 127.0.0.1:41001 --bytes 4000000000
//
// The sender writes generated data as fast as the stream takes it and prints the stream's own
// figures once a second; the receiver prints what arrived. Both ends must be started with each
// other's address. Stream ids are fixed: sender 1, receiver 2.
// UDX_NATIVE points at another build of udx-native, for comparing a patched libudx.
const UDX = require(process.env.UDX_NATIVE || 'udx-native')

const args = process.argv.slice(2)
const mode = args[0]
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i === -1 ? fallback : args[i + 1]
}
const port = Number(opt('port'))
const [peerHost, peerPort] = String(opt('peer', '')).split(':')
const total = Number(opt('bytes', 4e9))
const frameBytes = Number(opt('frame', 65536))
// The most the sending application supplies, in MB/s; 0 supplies as fast as the stream takes it.
const supply = Number(opt('supply', 0)) * 1e6
if (!['send', 'recv'].includes(mode) || !port || !peerPort) {
  console.error('usage: node pair.js send|recv --port <local> --peer <host:port> [--bytes n] [--frame n] [--supply MB/s] [--work ms] [--slice ms]')
  process.exit(1)
}

// Milliseconds of work the application does on its own thread per frame sent or received, as
// encrypting or decrypting it would be. The transport runs on that same thread.
const workMs = Number(opt('work', 0))
function work() {
  if (!workMs) return
  const until = performance.now() + workMs
  while (performance.now() < until) { /* busy */ }
}

// The longest the sender works in one go before handing the thread back to the event loop, in
// ms; 0 keeps writing until the stream pushes back, however long that takes.
const sliceMs = Number(opt('slice', 0))

// With --defer the sender never continues writing from inside the stream's own callback: the
// continuation runs on a later turn of the event loop.
const defer = args.includes('--defer')

const udx = new UDX()
const socket = udx.createSocket()
socket.bind(port)
const sending = mode === 'send'
const stream = udx.createStream(sending ? 1 : 2)
stream.connect(socket, sending ? 2 : 1, Number(peerPort), peerHost)

// PUNCH=1 on a receiver behind a stateful firewall: it sends first, so the sender's packets are
// let in.
if (process.env.PUNCH && !sending) {
  const punch = () => socket.send(Buffer.from('punch'), Number(peerPort), peerHost).catch(() => {})
  punch()
  setInterval(punch, 1000).unref()
}

const started = Date.now()
let moved = 0
let last = 0
let lastAt = started
const mb = (bytes) => (bytes / 1e6).toFixed(1).padStart(6)

function line() {
  const now = Date.now()
  const rate = (moved - last) / ((now - lastAt) / 1000)
  last = moved
  lastAt = now
  const t = String(Math.round((now - started) / 1000)).padStart(4)
  if (!sending) return `${t}s recv ${mb(rate)} MB/s`
  return `${t}s send ${mb(rate)} MB/s  cwnd ${String(stream.cwnd).padStart(5)}  inflight ${String(stream.inflight).padStart(8)}` +
    `  rtt ${String(stream.rtt).padStart(4)}  bbr state ${stream.bbrState} bw ${mb(stream.bbrBandwidth)} MB/s` +
    `  retransmits ${stream.retransmits}  rto ${stream.lifetimeRtoCount}`
}
const ticker = setInterval(() => console.log(line()), 1000)

// Processor time of this end, printed when it exits.
process.on('exit', () => {
  const cpu = process.cpuUsage()
  const total = (cpu.user + cpu.system) / 1e6
  require('fs').writeSync(2, `cpu ${sending ? 'send' : 'recv'}: user ${(cpu.user / 1e6).toFixed(1)} s, system ${(cpu.system / 1e6).toFixed(1)} s, per GB ${(total / (moved / 1e9)).toFixed(2)} s\n`)
})
process.on('SIGTERM', () => process.exit(0))

// FINE=<ms> FINE_OUT=<file> on the sender: the stream's state every <ms>, one line each, for
// episodes.py. Columns: ms since start, bytes transmitted, cwnd, inflight, bbr state, rtt, bw.
const fine = []
const fineMs = Number(process.env.FINE || 0)
const fineTicker = fineMs && sending
  ? setInterval(() => {
    fine.push([Date.now() - started, stream.bytesTransmitted, stream.cwnd, stream.inflight, stream.bbrState, stream.rtt, Math.round(stream.bbrBandwidth)].join(' '))
  }, fineMs)
  : null

function finish() {
  clearInterval(ticker)
  if (fineTicker) {
    clearInterval(fineTicker)
    require('fs').writeFileSync(process.env.FINE_OUT, fine.join('\n') + '\n')
  }
  const seconds = (Date.now() - started) / 1000
  console.log(`done: ${moved} bytes in ${seconds.toFixed(1)} s, ${mb(moved / seconds)} MB/s average`)
  stream.destroy()
  socket.close()
}

if (sending) {
  const frame = Buffer.alloc(frameBytes, 0x5a)
  // With --supply the application hands over data at that rate at most, in 10 ms portions, as a
  // sender does whose own work (reading, encrypting) is slower than the path.
  let allowance = supply ? 0 : Infinity
  const pump = () => {
    const sliceEnd = sliceMs ? performance.now() + sliceMs : Infinity
    while (moved < total && allowance >= frameBytes) {
      if (performance.now() >= sliceEnd) return setImmediate(pump)
      const size = Math.min(frameBytes, total - moved)
      moved += size
      allowance -= size
      work()
      if (!stream.write(size === frameBytes ? frame : frame.subarray(0, size))) return stream.once('drain', defer ? () => setImmediate(pump) : pump)
    }
    if (moved >= total) stream.end()
  }
  if (supply) {
    setInterval(() => {
      const starved = allowance < frameBytes
      allowance = Math.min(allowance + supply / 100, supply / 10)
      if (starved && moved < total) pump()
    }, 10).unref()
  }
  stream.on('finish', finish)
  stream.on('error', (err) => { console.error('stream error:', err.message); process.exit(1) })
  stream.resume()
  pump()
} else {
  // Data arrives a packet at a time; the work is done once per frame's worth of it.
  let unworked = 0
  stream.on('data', (data) => {
    moved += data.byteLength
    unworked += data.byteLength
    while (unworked >= frameBytes) { unworked -= frameBytes; work() }
  })
  stream.on('end', () => { stream.end(); finish() })
  stream.on('error', (err) => { console.error('stream error:', err.message); process.exit(1) })
}
