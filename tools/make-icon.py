"""生成墨阅的印章图标（PNG + 多尺寸 ICO）。需要 Pillow。"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "web" / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

SIZE = 512
PAPER = (247, 242, 230, 255)
INK_RED = (157, 48, 38, 255)
INK_RED_SOFT = (157, 48, 38, 120)

image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# 宣纸底、朱砂印框
draw.rounded_rectangle(
    (18, 18, SIZE - 18, SIZE - 18),
    radius=92,
    fill=PAPER,
    outline=INK_RED,
    width=30,
)
# 内框
draw.rounded_rectangle(
    (62, 62, SIZE - 62, SIZE - 62),
    radius=58,
    outline=INK_RED_SOFT,
    width=4,
)

# 中央「墨」字
font_path = Path(r"C:\Windows\Fonts\simkai.ttf")
if not font_path.exists():
    font_path = Path(r"C:\Windows\Fonts\msyhbd.ttc")
font = ImageFont.truetype(str(font_path), 292)

text = "墨"
box = draw.textbbox((0, 0), text, font=font, stroke_width=3)
text_w = box[2] - box[0]
text_h = box[3] - box[1]
x = (SIZE - text_w) / 2 - box[0]
y = (SIZE - text_h) / 2 - box[1] - 4
draw.text((x, y), text, font=font, fill=INK_RED, stroke_width=3, stroke_fill=INK_RED)

png_path = ASSETS / "moyue-icon.png"
ico_path = ASSETS / "moyue.ico"
image.save(png_path, "PNG")
image.save(
    ico_path,
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print(f"wrote {png_path}")
print(f"wrote {ico_path}")
