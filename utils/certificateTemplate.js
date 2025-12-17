import SystemConfig from '../models/SystemConfig.js';

export const CERTIFICATE_TEMPLATE_KEY = 'certificate_template';
export const MIN_CERTIFICATION_PERCENTAGE = 60;

export const DEFAULT_CERTIFICATE_TEMPLATE = {
  title: 'Certificate of Achievement',
  subtitle: 'This certifies that',
  message: 'We proudly present this certificate to {{studentName}} for successfully completing the {{examTitle}} examination.',
  secondaryMessage: 'Awarded on {{attemptDate}} with an overall score of {{percentage}}% ({{score}} / {{maxScore}}).',
  footerNote: 'Keep up the excellent work and continue striving for excellence.',
  logoUrl: '',
  backgroundColor: '#F8FAFF',
  primaryColor: '#1D4ED8',
  accentColor: '#60A5FA',
  textColor: '#1F2937',
  borderColor: '#CBD5F5',
  signature: {
    label: 'Authorized Signatory',
    name: 'Dr. Jane Smith',
    title: 'Director, Institute of Excellence',
    imageUrl: '',
  },
  seal: {
    enabled: false,
    imageUrl: '',
    label: 'Official Seal',
  },
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clone = (value) => JSON.parse(JSON.stringify(value));

const mergeDeep = (base, overrides) => {
  const target = clone(base);
  const apply = (targetNode, sourceNode) => {
    if (!isPlainObject(sourceNode)) {
      return;
    }
    Object.entries(sourceNode).forEach(([key, value]) => {
      if (value === undefined) {
        return;
      }
      if (isPlainObject(value)) {
        if (!isPlainObject(targetNode[key])) {
          targetNode[key] = {};
        }
        apply(targetNode[key], value);
      } else if (Array.isArray(value)) {
        targetNode[key] = value.map((item) =>
          isPlainObject(item) ? clone(item) : item
        );
      } else {
        targetNode[key] = value;
      }
    });
  };

  apply(target, overrides || {});
  return target;
};

const PLACEHOLDER_REGEX = /{{\s*([\w.]+)\s*}}/g;

const replacePlaceholdersInValue = (value, context) => {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_REGEX, (_, key) => {
      const replacement = context[key];
      if (replacement === undefined || replacement === null) {
        return '';
      }
      return String(replacement);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholdersInValue(item, context));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        replacePlaceholdersInValue(val, context),
      ])
    );
  }
  return value;
};

const parseTemplateValue = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
};

export const mergeWithDefaultTemplate = (overrides) =>
  mergeDeep(DEFAULT_CERTIFICATE_TEMPLATE, overrides);

export const loadCertificateTemplate = async (examTemplate = null) => {
  // If exam-specific template is provided, use it (merged with defaults)
  if (examTemplate && typeof examTemplate === 'object' && Object.keys(examTemplate).length > 0) {
    return mergeWithDefaultTemplate(examTemplate);
  }

  // Otherwise, load global template
  const config = await SystemConfig.findOne({
    key: CERTIFICATE_TEMPLATE_KEY,
  });

  if (!config) {
    return clone(DEFAULT_CERTIFICATE_TEMPLATE);
  }

  const parsed = parseTemplateValue(config.value);
  if (!parsed) {
    return clone(DEFAULT_CERTIFICATE_TEMPLATE);
  }

  return mergeWithDefaultTemplate(parsed);
};

export const persistCertificateTemplate = async (template, updatedBy) => {
  const mergedTemplate = mergeWithDefaultTemplate(template);

  await SystemConfig.findOneAndUpdate(
    { key: CERTIFICATE_TEMPLATE_KEY },
    {
      value: JSON.stringify(mergedTemplate),
      description: 'Custom certificate template configuration',
      updatedBy,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return mergedTemplate;
};

export const applyCertificateTemplate = (template, context) => {
  const merged =
    template && Object.keys(template).length > 0
      ? mergeWithDefaultTemplate(template)
      : clone(DEFAULT_CERTIFICATE_TEMPLATE);
  return replacePlaceholdersInValue(merged, context);
};

export const extractTemplatePlaceholders = () => [
  '{{studentName}}',
  '{{examTitle}}',
  '{{attemptDate}}',
  '{{issuedOn}}',
  '{{percentage}}',
  '{{score}}',
  '{{maxScore}}',
  '{{attemptId}}',
];


