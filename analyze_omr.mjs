import Jimp from 'jimp';
import fs from 'fs/promises';
import path from 'path';

async function analyze() {
    const dir = 'e:/Exam_Managemet/Exam-Management-Backend/uploads/omr';
    const files = await fs.readdir(dir);
    const lastImage = files.filter(f => f.endsWith('.png') && f.startsWith('177')).sort().pop();

    if (!lastImage) {
        console.log("No images found");
        return;
    }

    console.log("Analyzing:", lastImage);
    const img = await Jimp.read(path.join(dir, lastImage));
    img.greyscale();
    const { width: w, height: h } = img.bitmap;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = img.bitmap.data[i * 4];

    // Find paper corners
    let tl = { x: w, y: h }, br = { x: 0, y: 0 }, tr = { x: 0, y: h }, bl = { x: w, y: 0 };
    let found = false;
    for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
        if (gray[y * w + x] > 160) {
            found = true;
            if (x + y < tl.x + tl.y) { tl.x = x; tl.y = y; }
            if (x + y > br.x + br.y) { br.x = x; br.y = y; }
            if (x - y > tr.x - tr.y) { tr.x = x; tr.y = y; }
            if (x - y < bl.x - bl.y) { bl.x = x; bl.y = y; }
        }
    }
    console.log("Corners:", { tl, tr, br, bl });

    // Scan for "dark" spots in the middle vertical range to find where questions might be
    const ySpots = new Array(h).fill(0);
    const xRange = [Math.floor(w * 0.1), Math.floor(w * 0.4)]; // First column region
    for (let y = 0; y < h; y += 10) {
        let darkCount = 0;
        for (let x = xRange[0]; x < xRange[1]; x += 5) {
            if (gray[y * w + x] < 100) darkCount++;
        }
        ySpots[y] = darkCount;
    }

    console.log("Y-Axis Dark Spots (Top 2000px, sampled every 100px):");
    for (let y = 0; y < 2000; y += 100) {
        console.log(`Y=${y}: ${ySpots[y]}`);
    }
}

analyze();
