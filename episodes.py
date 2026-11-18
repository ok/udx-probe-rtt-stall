# Reports each PROBE_RTT episode of a run sampled with FINE: how long it lasted, how long the
# stream took to be back at 90 % of its rate, and how much it did not send meanwhile.
#
#   FINE=5 FINE_OUT=fine.txt node run-local.js --delay 0.7 --txop 4
#   python3 episodes.py fine.txt [episode-number-to-print-in-detail]
import sys,statistics as st
R=[list(map(int,l.split())) for l in open(sys.argv[1])]
eps=[];cur=None
for i,r in enumerate(R):
    if r[4]==3 and cur is None: cur=i
    if r[4]!=3 and cur is not None: eps.append((cur,i)); cur=None
def rate(i,j): return (R[j][1]-R[i][1])/max(1,(R[j][0]-R[i][0]))*1000/1e6
total=rate(0,len(R)-1)
print('samples',len(R),'sample gap median',st.median(b[0]-a[0] for a,b in zip(R,R[1:])),'ms; overall %.1f MB/s; episodes'%total,len(eps),'at s',[round(R[a][0]/1000,1) for a,b in eps])
lostsum=0
for n,(a,b) in enumerate(eps):
    t0=R[a][0]
    pre=next(i for i in range(a,-1,-1) if R[i][0]<=t0-2000) if t0>2500 else 0
    full=rate(pre,a)
    dr=next((i for i in range(a,b) if R[i][3]<=6000),None)
    rec=None
    for i in range(b,len(R)-1):
        j=next((k for k in range(i,len(R)) if R[k][0]>=R[i][0]+200),None)
        if j is None: break
        if rate(i,j)>=0.9*full: rec=i;break
    if rec is None: continue
    lost=full*((R[rec][0]-t0)/1000)-(R[rec][1]-R[a][1])/1e6; lostsum+=lost
    print(f" at {t0/1000:6.2f}s: rate before {full:.1f}; state 3 for {R[b][0]-t0} ms; drained after {R[dr][0]-t0 if dr else None} ms; back at 90% after {R[rec][0]-t0} ms; not sent {lost:.1f} MB; cwnd before {R[a-1][2]} at exit {R[b][2]}; bw before {R[a-1][6]/1e6:.1f} at exit {R[b][6]/1e6:.1f}; rtt in episode max {max(R[i][5] for i in range(a,b))}")
print('not sent in episodes: %.1f MB = %.1f%% of what the pre-episode rate would have carried'%(lostsum,100*lostsum/(lostsum+R[-1][1]/1e6)))
if len(sys.argv)>2:
    a,b=eps[int(sys.argv[2])]
    print('timeline (ms from start | MB/s over next ~50 ms | cwnd | inflight | state | rtt | bw):')
    i=max(0,a-20)
    while i<min(len(R)-1,b+160):
        j=next((k for k in range(i,len(R)) if R[k][0]>=R[i][0]+50),len(R)-1)
        print('  %5d %6.1f %4d %7d %d %3d %5.1f'%(R[i][0]-R[a][0],rate(i,j),R[i][2],R[i][3],R[i][4],R[i][5],R[i][6]/1e6)); i=j if j>i else i+1
