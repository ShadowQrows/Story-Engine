# Make TrueType copies of the bundled fonts (SIL OFL), for embedding in Word exports.
# Run from the project folder:  python3 tools/fonts-ttf.py   (needs: pip install fonttools brotli)
from fontTools.ttLib import TTFont
for name in ['LibreBaskerville', 'LibreBaskerville-Italic', 'UnifrakturMaguntia']:
    f = TTFont(f'fonts/{name}.woff2'); f.flavor = None; f.save(f'fonts/{name}.ttf')
    print(name, 'ok')
