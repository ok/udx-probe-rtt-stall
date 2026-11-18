// Runs the reproduction on one machine: a link, a receiver and a sender, each its own process,
// and afterwards counts the stalled seconds in the sender's output.
//
//   node run-local.js [--bytes 4000000000] [--mbit 400] [--delay 5] [--queue 1500000] [--txop 0] [--overhead 0.2] [--supply 0] [--frame 65536] [--send-work 0] [--recv-work 0] [--slice 0]
const { spawn } = require('child_process')
const path = require('path')

const passed = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = passed.indexOf('--' + name)
  return i === -1 ? fallback : passed[i + 1]
}
const bytes = opt('bytes', '4000000000')
const here = (file) => path.join(__dirname, file)
const node = process.execPath

const link = spawn(node, [here('link.js'), '--a', '41010:127.0.0.1:41000', '--b', '41011:127.0.0.1:41001',
  '--mbit', opt('mbit', '400'), '--delay', opt('delay', '5'), '--queue', opt('queue', '1500000'), '--txop', opt('txop', '0'), '--overhead', opt('overhead', '0.2')], { stdio: 'inherit' })
const recv = spawn(node, [here('pair.js'), 'recv', '--port', '41001', '--peer', '127.0.0.1:41011', '--work', opt('recv-work', '0')], { stdio: ['ignore', 'pipe', 'inherit'] })
const send = spawn(node, [here('pair.js'), 'send', '--port', '41000', '--peer', '127.0.0.1:41010', '--bytes', bytes, '--supply', opt('supply', '0'), '--frame', opt('frame', '65536'), '--work', opt('send-work', '0'), '--slice', opt('slice', '0'), ...(passed.includes('--defer') ? ['--defer'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] })

const rates = []
let buffered = ''
send.stdout.on('data', (chunk) => {
  buffered += chunk
  const lines = buffered.split('\n')
  buffered = lines.pop()
  for (const text of lines) {
    console.log(text)
    const m = /send\s+([\d.]+) MB\/s/.exec(text)
    if (m) rates.push(Number(m[1]))
  }
})
recv.stdout.on('data', () => {})

send.on('exit', (code) => {
  setTimeout(() => {
    recv.kill()
    link.kill('SIGTERM')
    const sorted = [...rates].sort((x, y) => x - y)
    const typical = sorted[Math.floor(sorted.length / 2)] ?? 0
    const stalled = rates.filter((rate) => rate < typical * 0.1).length
    console.log(`\n${rates.length} seconds sampled, typical ${typical} MB/s, ${stalled} seconds below a tenth of that`)
    process.exitCode = code ?? 1
  }, 500)
})
