# Run from this folder: python3 logo.py. Writes logo.svg: a browser window whose page dissolves into dither,
# coloured jade to cyan, over a soft blurred glow of itself.
N = 9
BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]

def mix(a, b, t):
    return "#" + "".join(f"{round(int(a[i:i+2], 16) * (1 - t) + int(b[i:i+2], 16) * t):02x}" for i in (1, 3, 5))

cells = []
for y in range(N):
    for x in range(N):
        if y == 0:
            on = True                      # the window's title bar
        elif y == 1:
            on = False                     # a gap under it
        else:
            # The page: full at the bottom left, thinning toward the top right.
            brightness = 1.15 - ((x / (N - 1)) * 0.65 + ((N - 1 - y) / (N - 3)) * 0.55)
            on = brightness > (BAYER4[y % 4][x % 4] + 0.5) / 16
        if on:
            # Dots shrink as the page goes to sleep, like it's blurring away.
            size = 2.7 if y == 0 else 1.3 + 1.4 * min(1, max(0, brightness))
            cells.append((x, y, size))

dots = "".join(f'<rect x="{x*3 + (2.7-z)/2:.2f}" y="{y*3 + (2.7-z)/2:.2f}" width="{z:.2f}" height="{z:.2f}" rx="0.35" fill="{mix("#1fd8a4", "#4ccce6", (x + (N-1-y)*0.5) / (N*1.5))}"/>' for x, y, z in cells)
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 30.6 30.6">
<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8"/></filter></defs>
<g filter="url(#glow)" opacity="0.8">{dots}</g>
<g>{dots}</g>
</svg>
'''
open("logo.svg", "w").write(svg)
for y in range(N):
    print("".join("█" if any(c[:2] == (x, y) for c in cells) else "·" for x in range(N)))
