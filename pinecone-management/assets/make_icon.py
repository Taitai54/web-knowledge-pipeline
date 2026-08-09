"""Generates a standout .ico for the pinecone-management desktop shortcut."""
import math
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
BG_DARK = (10, 20, 18, 255)
BG_DARK2 = (16, 34, 30, 255)
GREEN_HI = (70, 235, 150, 255)
GREEN_LO = (10, 150, 95, 255)
WHITE = (255, 255, 255, 255)

def rounded_rect_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))

def build_base():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    grad = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 255))
    gd = ImageDraw.Draw(grad)
    for y in range(SIZE):
        t = y / SIZE
        gd.line([(0, y), (SIZE, y)], fill=lerp(BG_DARK, BG_DARK2, t))
    mask = rounded_rect_mask(SIZE, radius=int(SIZE * 0.22))
    img.paste(grad, (0, 0), mask)
    return img

def draw_cone(img):
    """Stylized pinecone made of hex 'scale' nodes in spiral rows, with thin
    connecting lines between select nodes to nod at the vector/graph-db theme."""
    draw = ImageDraw.Draw(img, "RGBA")
    cx = SIZE * 0.5
    top_y = SIZE * 0.16
    bottom_y = SIZE * 0.86
    rows = 8
    nodes = []  # (x, y, r, color)

    for row in range(rows):
        t = row / (rows - 1)
        y = top_y + (bottom_y - top_y) * t
        # cone width: narrow at top, wide in the middle, tapering back in near
        # the bottom, like an actual pinecone silhouette.
        width_t = math.sin(t * math.pi) ** 0.6
        row_half_width = SIZE * 0.32 * width_t
        cols = max(1, int(2 + row * 1.1))
        offset = (SIZE * 0.05) if row % 2 == 0 else 0
        color = lerp(GREEN_HI, GREEN_LO, t)
        for c in range(cols):
            if cols == 1:
                x = cx
            else:
                ct = c / (cols - 1)
                x = cx - row_half_width + row_half_width * 2 * ct
            x += (offset - SIZE * 0.025) * (1 if c % 2 == 0 else -1) * 0.15
            r = SIZE * (0.052 - row * 0.001)
            nodes.append((x, y, r, color))

    # connecting lines first (behind nodes) to suggest a vector graph
    for i in range(0, len(nodes) - 1, 3):
        x1, y1, _, _ = nodes[i]
        x2, y2, _, _ = nodes[min(i + 3, len(nodes) - 1)]
        draw.line([(x1, y1), (x2, y2)], fill=(255, 255, 255, 40), width=int(SIZE * 0.004))

    for x, y, r, color in nodes:
        bbox = [x - r, y - r, x + r, y + r]
        draw.ellipse(bbox, fill=color)
        hi = [x - r * 0.35, y - r * 0.55, x + r * 0.15, y - r * 0.05]
        draw.ellipse(hi, fill=(255, 255, 255, 60))

    # small bright core node at the very top (the growth tip)
    tip_r = SIZE * 0.03
    draw.ellipse([cx - tip_r, top_y - SIZE * 0.05 - tip_r, cx + tip_r, top_y - SIZE * 0.05 + tip_r],
                 fill=WHITE)

def add_glow(img):
    glow = img.filter(ImageFilter.GaussianBlur(SIZE * 0.02))
    out = Image.alpha_composite(glow, img)
    return out

def main():
    base = build_base()
    draw_cone(base)
    final = add_glow(base)
    out_path = "assets/pinecone-management.ico"
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [final.resize((s, s), Image.LANCZOS) for s in sizes]
    imgs[-1].save(out_path, format="ICO", sizes=[(s, s) for s in sizes])
    final.resize((512, 512), Image.LANCZOS).save("assets/pinecone-management-preview.png")
    print("wrote", out_path)

if __name__ == "__main__":
    main()
