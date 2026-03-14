import cv2
import sys
import numpy as np

def analyze(image_path):
    image = cv2.imread(image_path)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    # Same warp logic to replicate pipeline
    # We just assume fallback (whole image warp)
    h, w = gray.shape
    docCnt = np.array([[[0,0]], [[w-1,0]], [[w-1,h-1]], [[0,h-1]]], dtype="int32")
    pts = docCnt.reshape(4, 2)
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    dst = np.array([[0,0], [1999,0], [1999,2799], [0,2799]], dtype="float32")
    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(gray, M, (2000, 2800))
    
    _, thresh = cv2.threshold(warped, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    
    row_sums = np.sum(thresh, axis=1) / 255.0
    col_sums = np.sum(thresh, axis=0) / 255.0

    print("Peaks in row sums (top 20):")
    pks = np.where(row_sums > np.mean(row_sums) * 1.5)[0]
    
    # cluster them
    stds = []
    current = []
    for p in pks:
        if not current:
            current.append(p)
        else:
            if p - current[-1] < 10:
                current.append(p)
            else:
                stds.append(int(np.mean(current)))
                current = [p]
    if current:
        stds.append(int(np.mean(current)))
    print("Row centers:", stds)

    print("Peaks in col sums:")
    pcol = np.where(col_sums > np.mean(col_sums) * 2)[0]
    stds_c = []
    current_c = []
    for p in pcol:
        if not current_c:
            current_c.append(p)
        else:
            if p - current_c[-1] < 10:
                current_c.append(p)
            else:
                stds_c.append(int(np.mean(current_c)))
                current_c = [p]
    if current_c:
        stds_c.append(int(np.mean(current_c)))
    print("Col centers:", stds_c)

if __name__ == "__main__":
    analyze(sys.argv[1])
