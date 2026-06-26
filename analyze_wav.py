import struct, sys
import numpy as np

path = r"recording.wav"
raw = open(path, "rb").read()

# --- minimal RIFF/WAVE parser ---
assert raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"
pos = 12
fmt = None
data = None
while pos + 8 <= len(raw):
    cid = raw[pos:pos+4]
    csz = struct.unpack("<I", raw[pos+4:pos+8])[0]
    body = raw[pos+8:pos+8+csz]
    if cid == b"fmt ":
        fmt = body
    elif cid == b"data":
        data = body
    pos += 8 + csz + (csz & 1)

afmt, ch, sr, byterate, block, bits = struct.unpack("<HHIIHH", fmt[:16])
print(f"format={afmt} channels={ch} sample_rate={sr} bits={bits} block={block}")

# --- decode 24-bit signed PCM, mono ---
n = len(data) // block
b = np.frombuffer(data[: n*block], dtype=np.uint8).reshape(n, block)
# little-endian 24-bit -> int32
x = (b[:,0].astype(np.int32)
     | (b[:,1].astype(np.int32) << 8)
     | (b[:,2].astype(np.int32) << 16))
x = np.where(x & 0x800000, x - 0x1000000, x).astype(np.float64) / 0x800000  # [-1,1)

dur = n / sr
print(f"samples={n} duration={dur:.3f}s peak={np.max(np.abs(x)):.4f} rms={np.sqrt(np.mean(x**2)):.5f}")

# --- frame energy (10 ms) to find dropouts & structure ---
fl = sr // 100
nf = n // fl
fr = x[: nf*fl].reshape(nf, fl)
fe = np.sqrt(np.mean(fr**2, axis=1))
active = fe > 1e-4
print(f"frames(10ms)={nf} active={active.sum()} ({100*active.mean():.1f}%)")

# dropouts: silent frames sandwiched between active frames
drop = 0
runs = []
i = 0
while i < nf:
    if not active[i]:
        j = i
        while j < nf and not active[j]:
            j += 1
        before = i > 0 and active[i-1]
        after = j < nf and active[j]
        if before and after:
            drop += 1
            runs.append((i*10, (j-i)*10))  # ms start, ms len
        i = j
    else:
        i += 1
print(f"interior_silence_gaps={drop}")
for s,l in runs[:40]:
    print(f"   gap @ {s/1000:.2f}s len {l}ms")

# --- click / discontinuity detection ---
d = np.abs(np.diff(x))
thr = 0.12
clicks = np.where(d > thr)[0]
print(f"\nmax|delta|={d.max():.4f}  clicks(>|{thr}|)={len(clicks)}")
# cluster click times
if len(clicks):
    ct = clicks / sr
    groups = [ct[0]]
    for t in ct[1:]:
        if t - groups[-1] > 0.02:
            groups.append(t)
    print(f"click_clusters={len(groups)}")
    for t in groups[:60]:
        print(f"   click @ {t:.3f}s")
    # spacing between click clusters (periodicity?)
    if len(groups) > 2:
        sp = np.diff(groups)
        print(f"click spacing: mean={np.mean(sp)*1000:.1f}ms median={np.median(sp)*1000:.1f}ms min={sp.min()*1000:.1f} max={sp.max()*1000:.1f}")

# --- spectral check on the loudest active second (aliasing/imaging) ---
if active.sum() > 100:
    # pick window around max energy
    c = int(np.argmax(fe)) * fl
    w = x[max(0,c-sr//2): c+sr//2]
    w = w * np.hanning(len(w))
    sp = np.abs(np.fft.rfft(w))
    freqs = np.fft.rfftfreq(len(w), 1/sr)
    sp /= (sp.max() + 1e-12)
    # energy fractions by band
    def band(lo,hi):
        m = (freqs>=lo)&(freqs<hi)
        return float(np.sum(sp[m]**2))
    tot = band(0, sr/2) + 1e-12
    print(f"\nspectral bands (fraction of energy):")
    for lo,hi in [(0,1000),(1000,4000),(4000,8000),(8000,12000),(12000,16000),(16000,24000)]:
        print(f"   {lo:5d}-{hi:5d}Hz: {100*band(lo,hi)/tot:5.1f}%")

# --- clipping + click/amplitude correlation ---
clip = np.sum(np.abs(x) >= 0.999)
print(f"\nclipped_samples(|x|>=0.999)={clip} ({100*clip/n:.3f}%)")
# local rms around each click vs global
if len(clicks):
    lr = []
    for i in clicks[:5000]:
        a=max(0,i-240); b=min(n,i+240)
        lr.append(np.sqrt(np.mean(x[a:b]**2)))
    lr=np.array(lr)
    print(f"local RMS at clicks: mean={lr.mean():.4f} (global rms=0.13559)")
# how many clicks have |delta| near full-scale wrap (>1.0 => sign flip/overflow)
big = np.sum(np.abs(np.diff(x))>1.0)
print(f"deltas>1.0 (sign-flip/wrap-like)={big}")
# repeated-chunk check: autocorr of |diff| at lags 1..1200 samples to spot framey repeats
dd = np.abs(np.diff(x))
dd = dd - dd.mean()
ac = np.correlate(dd[:200000], dd[:200000], mode='full')
mid=len(ac)//2
acn = ac[mid:mid+1300]/ac[mid]
peaks=[(l,acn[l]) for l in range(20,1300) if acn[l]>0.15]
peaks.sort(key=lambda p:-p[1])
print("autocorr peaks (lag_samples, val, =ms): " + ", ".join(f"{l}({l/48:.1f}ms):{v:.2f}" for l,v in peaks[:8]))
