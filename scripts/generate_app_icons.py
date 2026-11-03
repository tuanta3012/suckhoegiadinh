import os
import subprocess

def run(cmd):
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)

def main():
    os.makedirs('public', exist_ok=True)
    os.makedirs('resources/android', exist_ok=True)
    os.makedirs('src/assets/images', exist_ok=True)

    master_png = 'resources/icon.png'
    
    # Robust source checking: Use pre-existing resources/icon.png if available
    src_img = 'src/assets/images/stk_master_icon_1790815753552.jpg'
    if os.path.exists(src_img):
        # Scale master image up by 25% and crop center 1024x1024
        run(['convert', src_img, '-resize', '125%', '-gravity', 'center', '-extent', '1024x1024', master_png])
    elif not os.path.exists(master_png):
        if os.path.exists('public/stk_app_icon.png'):
            run(['convert', 'public/stk_app_icon.png', '-resize', '125%', '-gravity', 'center', '-extent', '1024x1024', master_png])
        else:
            print("Warning: No source icon found. Proceeding with existing assets if possible.")
    
    # 1. Ensure master icon has solid green background (#06B46F) and no transparent corners
    solid_master_png = 'resources/master_solid.png'
    run([
        'convert', master_png,
        '-background', '#06B46F',
        '-flatten',
        '-strip', '-colors', '256', '-depth', '8', '-define', 'png:compression-level=9',
        solid_master_png
    ])

    # 2. stk_app_icon.png in public (512x512) and src/assets/images
    run(['convert', solid_master_png, '-resize', '512x512', '-strip', '-colors', '256', '-depth', '8', '-define', 'png:compression-level=9', 'public/stk_app_icon.png'])
    # 3. Web favicon (64x64 & 32x32)
    run(['convert', solid_master_png, '-resize', '64x64', '-strip', 'public/favicon.png'])
    run(['convert', solid_master_png, '-resize', '32x32', '-strip', 'public/favicon-32x32.png'])
    run(['convert', solid_master_png, '-resize', '16x16', '-strip', 'public/favicon-16x16.png'])

    # 4. Apple Touch Icon (180x180)
    run(['convert', solid_master_png, '-resize', '180x180', '-strip', '-colors', '256', '-depth', '8', 'public/apple-touch-icon.png'])

    # 5. PWA icons
    run(['convert', solid_master_png, '-resize', '192x192', '-strip', '-colors', '256', '-depth', '8', 'public/pwa-192x192.png'])
    run(['convert', solid_master_png, '-resize', '512x512', '-strip', '-colors', '256', '-depth', '8', 'public/pwa-512x512.png'])

    # 5b. Capacitor assets source icons (resources/ & resources/android/)
    run(['convert', '-size', '1024x1024', 'xc:#06B46F', '-strip', '-colors', '16', 'resources/icon-background.png'])
    run([
        'convert', '-size', '1024x1024', 'xc:none',
        '(', solid_master_png, '-resize', '840x840', ')',
        '-gravity', 'center', '-composite',
        '-strip', '-colors', '256', '-depth', '8', '-define', 'png:compression-level=9',
        'resources/icon-foreground.png'
    ])
    os.makedirs('resources/android', exist_ok=True)
    run(['cp', 'resources/icon-background.png', 'resources/android/icon-background.png'])
    run(['cp', 'resources/icon-foreground.png', 'resources/android/icon-foreground.png'])

    # 6. Splash screen (2732x2732) with dark slate background (#0f172a) and centered logo
    run([
        'convert', '-size', '2732x2732', 'xc:#0f172a',
        '(', solid_master_png, '-resize', '768x768', ')',
        '-gravity', 'center', '-composite',
        '-strip', '-colors', '256', '-depth', '8', '-define', 'png:compression-level=9',
        'resources/splash.png'
    ])

    # 7. Android mipmap densities for Adaptive & Legacy icons
    densities = {
        'mipmap-mdpi': (48, 108),
        'mipmap-hdpi': (72, 162),
        'mipmap-xhdpi': (96, 216),
        'mipmap-xxhdpi': (144, 324),
        'mipmap-xxxhdpi': (192, 432),
    }

    base_res = 'android/app/src/main/res'
    for folder, (size, fg_size) in densities.items():
        dir_path = os.path.join(base_res, folder)
        os.makedirs(dir_path, exist_ok=True)
        
        # ic_launcher.png (legacy full-bleed icon, no transparent corners)
        run(['convert', solid_master_png, '-resize', f'{size}x{size}', '-strip', '-colors', '256', '-depth', '8', '-define', 'png:compression-level=9', os.path.join(dir_path, 'ic_launcher.png')])
        
        # ic_launcher_round.png
        run(['convert', solid_master_png, '-resize', f'{size}x{size}', '-strip', '-colors', '256', '-depth', '8', '-define', 'png:compression-level=9', os.path.join(dir_path, 'ic_launcher_round.png')])
        
        # ic_launcher_background.png (Full-bleed solid green adaptive background)
        run(['convert', '-size', f'{fg_size}x{fg_size}', 'xc:#06B46F', '-strip', '-colors', '16', os.path.join(dir_path, 'ic_launcher_background.png')])
        
        # ic_launcher_foreground.png (Logo centered, enlarged by 25% within safe zone)
        logo_size = int(fg_size * 0.82)
        run([
            'convert', '-size', f'{fg_size}x{fg_size}', 'xc:none',
            '(', solid_master_png, '-resize', f'{logo_size}x{logo_size}', ')',
            '-gravity', 'center', '-composite',
            '-strip', '-colors', '256', '-depth', '8', '-define', 'png:compression-level=9',
            os.path.join(dir_path, 'ic_launcher_foreground.png')
        ])

    # 8. Adaptive icon xml for Android 8+ (mipmap-anydpi-v26)
    v26_dir = os.path.join(base_res, 'mipmap-anydpi-v26')
    os.makedirs(v26_dir, exist_ok=True)
    
    launcher_xml = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
'''
    with open(os.path.join(v26_dir, 'ic_launcher.xml'), 'w') as f:
        f.write(launcher_xml)
    with open(os.path.join(v26_dir, 'ic_launcher_round.xml'), 'w') as f:
        f.write(launcher_xml)

    # 9. Color values for background
    values_dir = os.path.join(base_res, 'values')
    os.makedirs(values_dir, exist_ok=True)
    colors_xml = '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#06B46F</color>
</resources>
'''
    with open(os.path.join(values_dir, 'ic_launcher_background.xml'), 'w') as f:
        f.write(colors_xml)

    print("All app icons successfully generated!")

if __name__ == '__main__':
    main()
