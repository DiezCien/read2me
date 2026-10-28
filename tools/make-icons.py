"""Genera los iconos de la PWA a partir de _private/logo-square.png (requiere Pillow).

Uso: python3 tools/make-icons.py
El logo original es pequeño (250 px): los iconos de 512 px salen algo blandos.
Con un logo de 1024 px o más, basta con sustituir el archivo y volver a ejecutarlo.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

root = Path(__file__).resolve().parent.parent
src = Image.open(root / '_private' / 'logo-square.png').convert('RGBA')
cream = src.getpixel((0, 0))

# 1) recortar el cuadrado oscuro: todo lo que no es el fondo crema
def far_from_cream(px):
    return sum(abs(a - b) for a, b in zip(px[:3], cream[:3])) > 40
w, h = src.size
xs = [x for x in range(w) for y in range(0, h, 2) if far_from_cream(src.getpixel((x, y)))]
ys = [y for y in range(h) for x in range(0, w, 2) if far_from_cream(src.getpixel((x, y)))]
icon = src.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))

# 2) esquinas transparentes: solo el crema que toca el borde (no el blanco de los auriculares)
for corner in [(0, 0), (icon.width - 1, 0), (0, icon.height - 1), (icon.width - 1, icon.height - 1)]:
    ImageDraw.floodfill(icon, corner, (0, 0, 0, 0), thresh=40)

# quita el píxel de borde donde se mezcla el crema con el oscuro (evita el halo claro)
alpha = icon.getchannel('A').filter(ImageFilter.MinFilter(3))
icon.putalpha(alpha)

dark = icon.getpixel((icon.width // 2, 8))  # color de fondo del icono
side = max(icon.size)
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(icon, ((side - icon.width) // 2, (side - icon.height) // 2), icon)

out = root / 'icons'
out.mkdir(exist_ok=True)
for size in (192, 512):
    square.resize((size, size), Image.LANCZOS).save(out / f'icon-{size}.png')

# 3) versión "maskable": fondo oscuro a sangre y el icono dentro de la zona segura (≈70 %)
canvas = Image.new('RGBA', (512, 512), dark)
inset = round(min(icon.size) * 0.09)  # solo el interior: sin esquinas redondeadas ni bordes
core = icon.crop((inset, inset, icon.width - inset, icon.height - inset)).convert('RGB')
side_core = max(core.size)
inner = core.resize((400, round(400 * core.height / core.width)), Image.LANCZOS)
canvas.paste(inner, ((512 - inner.width) // 2, (512 - inner.height) // 2))
canvas.save(out / 'icon-maskable-512.png')
print('Iconos generados en', out, '· fondo', dark[:3])
