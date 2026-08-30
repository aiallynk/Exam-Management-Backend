import os from 'os';

// Which Python interpreter the offline-evaluation Python scripts run under.
// A deployment can pin a venv (with cv2 / numpy / pymupdf installed) via
// OFFLINE_EVAL_PYTHON or PYTHON_BIN without any code change; otherwise we try
// the usual names in order.
const explicit = String(process.env.OFFLINE_EVAL_PYTHON || process.env.PYTHON_BIN || '').trim();

export const PYTHON_CANDIDATES = explicit
  ? [explicit]
  : os.platform() === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];

// The first choice — callers that don't want fallback logic use this.
export const PYTHON_EXECUTABLE = PYTHON_CANDIDATES[0];

// A missing-dependency / missing-interpreter signature in a Python stderr
// dump, so the backend log can point straight at the fix instead of just
// "invalid response".
export const looksLikePythonEnvProblem = (stderr = '') =>
  /ModuleNotFoundError|No module named|ImportError|libGL\.so|cannot open shared object|command not found|is not recognized/i.test(
    String(stderr || '')
  );

export const PYTHON_ENV_HINT =
  'The offline-evaluation Python normalizer could not run. It needs Python 3 with PyMuPDF: ' +
  '`python3 -m pip install pymupdf` (or `-r services/offlineEvaluation/requirements.txt`), ' +
  'or point OFFLINE_EVAL_PYTHON at a venv that has it. OpenCV is optional (cosmetic only).';
