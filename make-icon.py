"""由源图生成应用图标：build/icon.ico（多尺寸）、build/icon.png、assets/logo.png

新源图 PB_logo_icon_1024.png 已自带正确 alpha 通道（背景已镂空），
所以这里不做任何抠图，只需：
  1) 用 alpha 通道 getbbox() 定位内容范围
  2) 留 4% 边距裁出、居中贴到正方形画布（保持透明）
  3) 输出 UI 用 512px logo 与多尺寸 ICO

注意：旧逻辑是为“无 alpha 的棋盘格水印图”写的 flood-fill 抠图，已废弃。
"""
import os
import struct
import io
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = r"C:\Users\Felix\WorkBuddy\2026-09-13-14-08-07\outputs\PB_logo_icon_1024.png"
ICO = os.path.join(HERE, "build", "icon.ico")
PNG256 = os.path.join(HERE, "build", "icon.png")
LOGO = os.path.join(HERE, "assets", "logo.png")
SIZES = [16, 24, 32, 48, 64, 128, 256]


def build_logo():
    im = Image.open(SRC).convert("RGBA")

    # 1) alpha 通道定位内容框（非全透明区域）
    alpha = im.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise SystemExit("源图没有不透明内容")
    minx, miny, maxx, maxy = bbox

    # 2) 留 4% 边距
    cw0, ch0 = im.size
    pad = int((maxx - minx) * 0.04)
    minx = max(0, minx - pad)
    miny = max(0, miny - pad)
    maxx = min(cw0 - 1, maxx + pad)
    maxy = min(ch0 - 1, maxy + pad)

    crop = im.crop((minx, miny, maxx + 1, maxy + 1))
    cw, ch = crop.size

    # 3) 居中贴到正方形画布（保持透明）
    side = max(cw, ch)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(crop, ((side - cw) // 2, (side - ch) // 2), crop)
    return canvas


def ico_bmp_entry(img):
    """32bpp BMP + AND 掩码（小尺寸兼容性最好）"""
    w, h = img.size
    data = img.tobytes("raw", "BGRA")            # 自上而下
    rows = [data[i * w * 4:(i + 1) * w * 4] for i in range(h)]
    xor = b"".join(reversed(rows))               # BMP 自下而上
    stride = ((w + 31) // 32) * 4
    and_mask = bytearray()
    for y in range(h - 1, -1, -1):
        line = bytearray(stride)
        for x in range(w):
            if img.getpixel((x, y))[3] < 128:
                line[x >> 3] |= 0x80 >> (x & 7)
        and_mask += line
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0,
                         len(xor) + len(and_mask), 0, 0, 0, 0)
    return header + xor + bytes(and_mask)


def _to_png(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def main():
    logo = build_logo()
    print("logo size:", logo.size)

    os.makedirs(os.path.join(HERE, "build"), exist_ok=True)
    os.makedirs(os.path.join(HERE, "assets"), exist_ok=True)

    # UI 用 logo（512，透明）
    ui = logo.resize((512, 512), Image.LANCZOS)
    ui.save(LOGO)
    print("saved", LOGO)

    # 图标各尺寸
    frames = [(s, logo.resize((s, s), Image.LANCZOS)) for s in SIZES]
    frames[-1][1].save(PNG256)
    print("saved", PNG256)

    entries = []
    for s, r in frames:
        blob = _to_png(r) if s >= 256 else ico_bmp_entry(r)
        entries.append((s, blob))

    out = bytearray(struct.pack("<HHH", 0, 1, len(entries)))
    offset = 6 + 16 * len(entries)
    body = bytearray()
    for s, blob in entries:
        out += struct.pack("<BBBBHHII",
                            s if s < 256 else 0, s if s < 256 else 0,
                            0, 0, 1, 32, len(blob), offset)
        body += blob
        offset += len(blob)
    with open(ICO, "wb") as f:
        f.write(bytes(out) + bytes(body))
    print("saved", ICO, os.path.getsize(ICO), "bytes")


if __name__ == "__main__":
    main()
