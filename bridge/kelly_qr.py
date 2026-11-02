#!/usr/bin/env python3
"""A small QR code encoder for the Kelly bridge -- no pip dependency (Raspberry Pi OS ships neither segno nor qrcode).

Byte mode, error correction level M, versions 1-10 (up to 213 bytes: a Kelly URL with its token is ~60), the
lowest-penalty mask of the eight. Used by `kelly_bridge.py --connect-qr` to put "open Kelly on your phone" in the
terminal, and by install-pi.sh at the end of an install.

  matrix(text)   -> list of rows of bools (True = dark), no quiet zone
  terminal(text) -> the code as Unicode half-blocks, light modules drawn, so it reads on a dark terminal
                    (two module rows per text line; phone cameras read the inverted code as well)

Follows ISO/IEC 18004 the same way as Nayuki's reference QR generator (MIT); checked against the vendored
jsQR decoder by test_kelly_qr.py.
"""
from __future__ import annotations

# per version 1..10 at level M: EC codewords per block, number of blocks (index 0 unused)
_ECC_PER_BLOCK = (0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26)
_BLOCKS = (0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5)
_ECL_M = 0          # format-info bits for level M
MAX_VERSION = 10


def _raw_modules(ver: int) -> int:
    """Data + EC modules in a symbol of this version (all but function patterns and format / version info)."""
    n = (16 * ver + 128) * ver + 64
    if ver >= 2:
        a = ver // 7 + 2
        n -= (25 * a - 10) * a - 55
        if ver >= 7:
            n -= 36
    return n


def _data_codewords(ver: int) -> int:
    return _raw_modules(ver) // 8 - _ECC_PER_BLOCK[ver] * _BLOCKS[ver]


def _gf_mul(x: int, y: int) -> int:
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(degree: int) -> list[int]:
    out = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            out[j] = _gf_mul(out[j], root)
            if j + 1 < degree:
                out[j] ^= out[j + 1]
        root = _gf_mul(root, 0x02)
    return out


def _rs_remainder(data: list[int], divisor: list[int]) -> list[int]:
    out = [0] * len(divisor)
    for b in data:
        factor = b ^ out.pop(0)
        out.append(0)
        for i, c in enumerate(divisor):
            out[i] ^= _gf_mul(c, factor)
    return out


def _codewords(data: bytes) -> tuple[int, list[int]]:
    """Pick the smallest version that fits, and return it with the final interleaved codewords (data + EC)."""
    for ver in range(1, MAX_VERSION + 1):
        cc_bits = 8 if ver <= 9 else 16
        cap = _data_codewords(ver) * 8
        if 4 + cc_bits + 8 * len(data) <= cap:
            break
    else:
        raise ValueError(f"too long for a version {MAX_VERSION} QR code ({len(data)} bytes)")
    bits: list[int] = []
    put = lambda v, n: bits.extend((v >> i) & 1 for i in range(n - 1, -1, -1))
    put(0b0100, 4)
    put(len(data), cc_bits)
    for b in data:
        put(b, 8)
    put(0, min(4, cap - len(bits)))
    put(0, -len(bits) % 8)
    words = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = 0xEC
    while len(words) < cap // 8:
        words.append(pad)
        pad ^= 0xEC ^ 0x11
    # split into blocks, add EC to each, interleave
    nblk, ecc = _BLOCKS[ver], _ECC_PER_BLOCK[ver]
    raw = _raw_modules(ver) // 8
    nshort, short_len = nblk - raw % nblk, raw // nblk
    div = _rs_divisor(ecc)
    blocks, k = [], 0
    for i in range(nblk):
        dat = words[k:k + short_len - ecc + (0 if i < nshort else 1)]
        k += len(dat)
        e = _rs_remainder(dat, div)
        if i < nshort:
            dat = dat + [0]
        blocks.append(dat + e)
    out = []
    for i in range(len(blocks[0])):
        for j, blk in enumerate(blocks):
            if i != short_len - ecc or j >= nshort:
                out.append(blk[i])
    return ver, out


def _align_positions(ver: int) -> list[int]:
    if ver == 1:
        return []
    n = ver // 7 + 2
    step = (ver * 8 + n * 3 + 5) // (n * 4 - 4) * 2
    pos = [0] * n
    p = ver * 4 + 17 - 7
    for i in range(n - 1, 0, -1):
        pos[i] = p
        p -= step
    pos[0] = 6
    return pos


_MASKS = (
    lambda x, y: (x + y) % 2 == 0,
    lambda x, y: y % 2 == 0,
    lambda x, y: x % 3 == 0,
    lambda x, y: (x + y) % 3 == 0,
    lambda x, y: (x // 3 + y // 2) % 2 == 0,
    lambda x, y: x * y % 2 + x * y % 3 == 0,
    lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
    lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
)


class _Symbol:
    def __init__(self, ver: int):
        self.ver, self.size = ver, ver * 4 + 17
        self.m = [[False] * self.size for _ in range(self.size)]
        self.fn = [[False] * self.size for _ in range(self.size)]

    def setf(self, x: int, y: int, dark: bool):
        self.m[y][x] = dark
        self.fn[y][x] = True

    def functions(self):
        s = self.size
        for i in range(s):
            self.setf(6, i, i % 2 == 0)
            self.setf(i, 6, i % 2 == 0)
        for cx, cy in ((3, 3), (s - 4, 3), (3, s - 4)):
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < s and 0 <= y < s:
                        self.setf(x, y, max(abs(dx), abs(dy)) not in (2, 4))
        pos = _align_positions(self.ver)
        n = len(pos)
        for i in range(n):
            for j in range(n):
                if (i == 0 and j == 0) or (i == 0 and j == n - 1) or (i == n - 1 and j == 0):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self.setf(pos[i] + dx, pos[j] + dy, max(abs(dx), abs(dy)) != 1)
        self.format(0)
        if self.ver >= 7:
            rem = self.ver
            for _ in range(12):
                rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
            bits = self.ver << 12 | rem
            for i in range(18):
                bit = (bits >> i) & 1 == 1
                a, b = s - 11 + i % 3, i // 3
                self.setf(a, b, bit)
                self.setf(b, a, bit)

    def format(self, mask: int):
        data = _ECL_M << 3 | mask
        rem = data
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        bits = (data << 10 | rem) ^ 0x5412
        bit = lambda i: (bits >> i) & 1 == 1
        s = self.size
        for i in range(6):
            self.setf(8, i, bit(i))
        self.setf(8, 7, bit(6))
        self.setf(8, 8, bit(7))
        self.setf(7, 8, bit(8))
        for i in range(9, 15):
            self.setf(14 - i, 8, bit(i))
        for i in range(8):
            self.setf(s - 1 - i, 8, bit(i))
        for i in range(8, 15):
            self.setf(8, s - 15 + i, bit(i))
        self.setf(8, s - 8, True)   # the dark module

    def place(self, words: list[int]):
        s, i, n = self.size, 0, len(words) * 8
        right = s - 1
        while right >= 1:
            if right == 6:
                right = 5
            for vert in range(s):
                for j in range(2):
                    x = right - j
                    y = s - 1 - vert if ((right + 1) & 2) == 0 else vert
                    if not self.fn[y][x] and i < n:
                        self.m[y][x] = (words[i >> 3] >> (7 - (i & 7))) & 1 == 1
                        i += 1
            right -= 2

    def mask(self, k: int):
        f = _MASKS[k]
        for y in range(self.size):
            for x in range(self.size):
                if not self.fn[y][x] and f(x, y):
                    self.m[y][x] = not self.m[y][x]

    def penalty(self) -> int:
        s, m, p = self.size, self.m, 0
        lines = m + [[m[y][x] for y in range(s)] for x in range(s)]
        finder_a = [True, False, True, True, True, False, True, False, False, False, False]
        finder_b = finder_a[::-1]
        for row in lines:
            run, prev = 0, None
            for v in row:
                if v == prev:
                    run += 1
                else:
                    if run >= 5:
                        p += 3 + run - 5
                    run, prev = 1, v
            if run >= 5:
                p += 3 + run - 5
            for i in range(s - 10):
                seg = row[i:i + 11]
                if seg == finder_a or seg == finder_b:
                    p += 40
        for y in range(s - 1):
            for x in range(s - 1):
                if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                    p += 3
        dark = sum(map(sum, m))
        p += 10 * (abs(dark * 100 // (s * s) - 50) // 5)
        return p


def matrix(text: str | bytes) -> list[list[bool]]:
    data = text.encode("utf-8") if isinstance(text, str) else bytes(text)
    ver, words = _codewords(data)
    q = _Symbol(ver)
    q.functions()
    q.place(words)
    best, best_p = 0, None
    for k in range(8):
        q.mask(k)
        q.format(k)
        pk = q.penalty()
        if best_p is None or pk < best_p:
            best, best_p = k, pk
        q.mask(k)   # XOR again: undo
    q.mask(best)
    q.format(best)
    return q.m


def terminal(text: str | bytes, quiet: int = 2) -> str:
    """The code as Unicode half-blocks (light modules drawn), with a light quiet zone of `quiet` modules."""
    m = matrix(text)
    n = len(m) + 2 * quiet
    light = lambda x, y: not (quiet <= x < n - quiet and quiet <= y < n - quiet and m[y - quiet][x - quiet])
    rows = []
    for y in range(0, n, 2):
        line = []
        for x in range(n):
            top, bot = light(x, y), (light(x, y + 1) if y + 1 < n else False)
            line.append("█" if top and bot else "▀" if top else "▄" if bot else " ")
        rows.append("".join(line))
    return "\n".join(rows)


if __name__ == "__main__":
    import sys
    print(terminal(" ".join(sys.argv[1:]) or "https://example.org/"))
