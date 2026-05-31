const path = require('path');
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const pdfjs = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');

pdfjs.disableWorker = true;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const ISSUES = ['Entrapment', 'Door Issue', 'Mechanical Failure', 'Power Outage', 'Inspection Issue', 'Noise/Vibration', 'Other'];
const STATS = ['Open', 'In Progress', 'Resolved'];
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

function getEnv(name) {
  return globalThis.Netlify?.env?.get?.(name) || process.env[name] || '';
}

const AI_SYSTEM_PROMPT = `You are an expert elevator incident data extractor.
Return ONLY valid JSON with these exact keys. No extra text.

{
  "date": "YYYY-MM-DD — use the FIRST real incident date",
  "building": "Use 'Client' for Incident Reports, 'LOCATION OF THE PROBLEM' for Call Logs",
  "elevator": "Format: 'Elevator X'. Convert CAB # number to letter if needed (1=A, 7=G, etc.)",
  "issue_type": "One of: Entrapment, Door Issue, Mechanical Failure, Power Outage, Inspection Issue, Noise/Vibration, Other. ALWAYS 'Entrapment' for Incident Reports",
  "status": "Open / In Progress / Resolved based on document clues",
  "description": "2-3 sentences including elevator ID and any ticket number",
  "resolution_notes": "Actions taken and technician name if mentioned"
}`;

// ── Text Helpers ──────────────────────────────────────────────────────────────
function normText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function normalizeDate(raw) {
  if (!raw) return '';
  const s = String(raw).replace(/\./g, '/').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const slash = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slash) {
    const mo = slash[1].padStart(2, '0');
    const d = slash[2].padStart(2, '0');
    const yr = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${yr}-${mo}-${d}`;
  }
  const p = new Date(s);
  return isNaN(p.getTime()) ? '' : p.toISOString().slice(0, 10);
}

function getFirstDate(text) {
  const cleaned = text.replace(/\bWN\d{6,8}\b/gi, '').replace(/\(Rev\s+\d{1,2}\/\d{1,2}\/\d{2,4}\)/gi, '');
  const mo = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  const rx = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\/\\d{1,2}\\/\\d{4}\\b|\\b(?:${mo})\\s+\\d{1,2},?\\s+\\d{4}\\b`, 'ig');
  for (const m of cleaned.matchAll(rx)) {
    const d = normalizeDate(m[0]);
    if (d) return d;
  }
  return '';
}

function escapeRx(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findLabeledValue(text, labels) {
  for (const label of labels) {
    const rx = new RegExp(`(?:^|\\n)${escapeRx(label)}\\s*[:\\-]\\s*(.+)`, 'i');
    const match = text.match(rx);
    const value = cleanExtractedValue(match && match[1]);
    if (value) return value;
  }
  return '';
}

function cleanExtractedValue(value) {
  const cleaned = String(value || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!cleaned) return '';
  if (!cleaned.replace(/[_\s:./\\\-()?]+/g, '')) return '';
  return cleaned;
}

function findFormFieldValue(text, fieldNamePattern) {
  const rx = new RegExp(
    `(?:^|\\n)\\[FORM FIELD\\]\\s*${fieldNamePattern}\\s*:\\s*([\\s\\S]*?)(?=\\n\\[FORM FIELD\\]|$)`,
    'i'
  );
  const match = text.match(rx);
  return cleanExtractedValue(match && match[1]);
}

function getSection(text, startLabel, endLabels = []) {
  const source = `\n${text}`;
  const startRx = new RegExp(`\\n${escapeRx(startLabel)}\\s*:?\\s*`, 'i');
  const startMatch = source.match(startRx);
  if (!startMatch) return '';

  const startIndex = (startMatch.index || 0) + startMatch[0].length;
  const rest = source.slice(startIndex);
  let endIndex = rest.length;

  for (const label of endLabels) {
    const endRx = new RegExp(`\\n${escapeRx(label)}\\s*:?`, 'i');
    const endMatch = rest.match(endRx);
    if (endMatch && typeof endMatch.index === 'number') {
      endIndex = Math.min(endIndex, endMatch.index);
    }
  }

  return rest.slice(0, endIndex).trim();
}

function pickRelevantSentences(text, maxSentences = 2) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  const keys = /(elevator|lift|cab|stuck|trapped|entrap|door|fault|alarm|out of service|technician|rescue|release|repair|service|ticket|reference|returned to service|brake|switch)/i;
  const sentences = cleaned.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const relevant = sentences.filter(sentence => keys.test(sentence));
  return (relevant.length ? relevant : sentences).slice(0, maxSentences).join(' ').trim();
}

function extractIncidentDate(text) {
  const cleaned = text.replace(/(?:rev|wn)\s*\d{6,8}|\(Rev\s*\d{1,2}\/\d{1,2}\/\d{2,4}\)/ig, '');
  const patterns = [
    /\bDate\s*[:\-]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /\bOn\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i,
    /\bOn\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i
  ];

  for (const rx of patterns) {
    const match = cleaned.match(rx);
    if (match) return normalizeDate(match[1]);
  }

  return getFirstDate(cleaned);
}

function extractIncidentLocation(text) {
  const explicit = extractLocation(text);
  if (explicit) return explicit;

  const floor = text.match(/(?:stuck near|stuck on|on the|to the)\s+(\d{1,2})(?:st|nd|rd|th)?\s+floor/i);
  if (floor) return `${floor[1]}th Floor`;
  return '';
}

function extractPersonInvolved(text) {
  const formPerson = findFormFieldValue(text, 'Persons\\s+Involved[^:]*Row1');
  if (formPerson) return formPerson.trim();

  const withInside = text.match(/with\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+inside/i);
  if (withInside) return withInside[1].trim();

  const identified = text.match(/identified as\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i);
  if (identified) return identified[1].trim();
  return '';
}

function inferIssueFromText(text) {
  const lower = String(text || '').toLowerCase();
  const noEntrapment = /no\s+entrapment|without\s+entrapment/.test(lower);

  if (!noEntrapment && /entrap|trapped|stuck inside/.test(lower)) return 'Entrapment';
  if (/power|outage|blackout/.test(lower)) return 'Power Outage';
  if (/inspection|violation|code/.test(lower)) return 'Inspection Issue';
  if (/noise|vibration|rattle/.test(lower)) return 'Noise/Vibration';
  if (/door|closing|opening|reopen/.test(lower)) return 'Door Issue';
  if (/out of service|brake|motor|shutdown|fault|mechanical|reset|switch|repair/.test(lower)) return 'Mechanical Failure';
  return 'Other';
}

function buildIncidentDescription(fields) {
  const parts = [];

  if (fields.date && fields.person && fields.elevator && fields.building) {
    parts.push(`On ${fields.date}, ${fields.person} became trapped inside ${fields.elevator} at ${fields.building}.`);
  } else if (fields.elevator && fields.building) {
    parts.push(`${fields.elevator} was involved in an incident at ${fields.building}.`);
  } else if (fields.elevator) {
    parts.push(`Incident involving ${fields.elevator}.`);
  }

  if (fields.location) {
    parts.push(`The elevator was reported near ${fields.location}, and security responded.`);
  }

  if (fields.reference) {
    parts.push(`Reference: ${fields.reference}.`);
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ... (keeping all your original helper functions: extractCab, cabToElevator, etc.)
// I'll include them all below for completeness

function findOptionMatch(raw, options) {
  if (!raw) return '';
  const l = String(raw).toLowerCase();
  return options.find(o => l.includes(o.toLowerCase())) || '';
}

function extractCab(text) {
  const formCab = findFormFieldValue(text, 'CAB\\s*#?');
  if (formCab) return formCab.trim().toUpperCase();

  const patterns = [
    /\bCAB\s*#\s*[:\-]?\s*([A-Z])\b/i,
    /\bCAB\s*#?\s*[:\-]\s*([A-Z])\b/i,
    /\bCAB\s*#\s*[:\-]?\s*(\d{1,2})\b/i,
    /Service\s+Elevator\s+Cab\s*#\s*(\d{1,2})/i,
    /Elevator\s+Cab\s*#\s*(\d{1,2})/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m) return m[1].trim().toUpperCase();
  }
  return '';
}

function cabToElevator(raw) {
  if (!raw) return '';
  const up = String(raw).toUpperCase().trim();
  if (/^[A-Z]$/.test(up)) return `Elevator ${up}`;
  const n = parseInt(up, 10);
  if (!isNaN(n) && n >= 1 && n <= 26) return `Elevator ${n}`;
  return '';
}

function extractLocation(text) {
  const formLocation = findFormFieldValue(text, 'LOCATION\\s+OF\\s+THE\\s+PROBLEM');
  if (formLocation) return formLocation;

  const m = text.match(/(?:^|\n)LOCATION\s+OF\s+THE\s+PROBLEM\s*[:\-]\s*(.+)/im);
  if (!m) return '';

  const beforeCab = m[1].split(/\bCAB\s*#?\b/i)[0];
  return cleanExtractedValue(beforeCab);
}

function extractClient(text) {
  const formClient = findFormFieldValue(text, 'Client');
  if (formClient) return formClient;

  const m = text.match(/\bClient\s*[:\-]\s*(.+)/i);
  return cleanExtractedValue(m && m[1]);
}

function extractBuilding(text) {
  if (/one\s+buckhead\s+plaza/i.test(text) || /\bOBP\b/i.test(text)) return 'One Buckhead Plaza';
  return extractLocation(text) || extractClient(text) || '';
}

function extractReference(text) {
  const patterns = [
    /service\s+(?:ticket\s+)?reference\s*(?:number\s*)?#?\s*([A-Z0-9]{5,})/i,
    /ticket\s*#\s*([A-Z0-9]{5,})/i,
    /#\s*([0-9]{5,})/,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m) return `#${m[1].replace(/^#/, '')}`;
  }
  return '';
}

function stringifyAnnotationValue(value) {
  if (Array.isArray(value)) return value.map(stringifyAnnotationValue).filter(Boolean).join(', ');
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r/g, '\n').replace(/\s+\n/g, '\n').trim();
}

async function extractPdfFormFieldText(buffer) {
  let doc;
  const lines = [];

  try {
    doc = await pdfjs.getDocument(buffer);

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const annotations = await page.getAnnotations();

      for (const annotation of annotations) {
        const name = String(annotation.fieldName || annotation.alternativeText || '').trim();
        const value = stringifyAnnotationValue(annotation.fieldValue);
        if (!name || !value || /_af_image/i.test(name)) continue;
        lines.push(`[FORM FIELD] ${name}: ${value}`);
      }
    }
  } finally {
    if (doc) await doc.destroy();
  }

  return normText(lines.join('\n'));
}

function detectType(text) {
  if (/ELEVATOR\s+CALL\s+LOG/i.test(text)) return 'call_log';
  if (/Incident\s+Report/i.test(text)) return 'incident_report';
  return 'generic';
}

async function callOpenAI(text) {
  const apiKey = getEnv('OPENAI_API_KEY').trim();
  if (!apiKey) throw new Error('missing_key');
  const model = getEnv('OPENAI_MODEL').trim() || DEFAULT_OPENAI_MODEL;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: text.slice(0, 7000) }
      ]
    })
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    console.error(`OpenAI Error ${res.status}:`, errorText);
    throw new Error(`openai_${res.status}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '';
  if (!raw) throw new Error('openai_empty');

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('openai_json_invalid');
  }
}

// ── Local Fallback (kept as safety net) ─────────────────────────────────────
function parseLocal(text) {
  const normalized = normText(text);
  const type = detectType(normalized);
  const cab = extractCab(normalized);
  const elevator = cabToElevator(cab) || 'Elevator 1';
  const reference = extractReference(normalized);
  const date = extractIncidentDate(normalized) || new Date().toISOString().slice(0, 10);

  if (type === 'incident_report') {
    const building = extractBuilding(normalized) || 'Unknown Location';
    const person = extractPersonInvolved(normalized);
    const location = extractIncidentLocation(normalized) || building;
    const actionNotes =
      findFormFieldValue(normalized, 'Action\\s+Taken[^:]*Row1') ||
      getSection(normalized, 'Action(s) Taken', ['Technician', 'Signature', 'Date']);
    const description = buildIncidentDescription({
      date,
      person,
      elevator,
      building,
      location,
      reference
    }) || `Incident involving ${elevator}. ${reference ? `Reference: ${reference}.` : ''}`.trim();

    return {
      date,
      building,
      location,
      elevator,
      issue: 'Entrapment',
      status: /released safely|released without injury|rescued/i.test(normalized) ? 'Resolved' : 'Open',
      description,
      notes: pickRelevantSentences(actionNotes || normalized, 2) || 'No additional notes.',
      reference: reference || 'N/A'
    };
  }

  if (type === 'call_log') {
    const building = extractLocation(normalized) || 'Unknown Location';
    const problemSection =
      findFormFieldValue(normalized, 'DESCRIPTION\\s+OF\\s+THE\\s+PROBLEM(?!_2)') ||
      getSection(normalized, 'DESCRIPTION OF THE PROBLEM', [
        'FULL NAME OF THE ELEVATOR TECHNICIAN',
        'ACTUAL TIME OF ARRIVAL',
        'Technician notes',
        'Action(s) Taken'
      ]);
    const techNotes =
      findFormFieldValue(normalized, 'DESCRIPTION\\s+OF\\s+THE\\s+PROBLEM_2') ||
      getSection(normalized, 'Technician notes', [
        'FULL NAME OF THE ELEVATOR TECHNICIAN',
        'ACTUAL TIME OF ARRIVAL',
        'Action(s) Taken'
      ]) ||
      cleanExtractedValue(normalized.match(/Technician notes\s*[:\-]\s*(.+)/i)?.[1]);
    const combined = `${problemSection} ${techNotes}`.trim();
    const technician =
      findFormFieldValue(normalized, 'FULL\\s+NAME\\s+OF\\s+THE\\s+ELEVATOR\\s+TECHNICIAN') ||
      cleanExtractedValue(normalized.match(/FULL\s+NAME\s+OF\s+THE\s+ELEVATOR\s+TECHNICIAN\s*[:\-]\s*(.+)/i)?.[1]);
    const arrival =
      findFormFieldValue(normalized, 'ACTUAL\\s+TIME\\s+OF\\s+ARRIVAL') ||
      cleanExtractedValue(normalized.match(/ACTUAL\s+TIME\s+OF\s+ARRIVAL\s*[:\-]\s*(.+)/i)?.[1]);
    const issue = inferIssueFromText(combined || normalized);
    const detail = pickRelevantSentences(combined || normalized, 2);
    const description = [
      elevator ? `${elevator} was reported at ${building}.` : `Incident reported at ${building}.`,
      detail,
      reference ? `Reference: ${reference}.` : ''
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const notes = pickRelevantSentences([technician ? `Technician: ${technician}.` : '', techNotes].filter(Boolean).join(' '), 2) || 'No additional notes.';

    return {
      date,
      building,
      location: building,
      elevator,
      issue,
      status: technician && arrival ? 'Resolved' : 'Open',
      description,
      notes,
      reference: reference || 'N/A'
    };
  }

  const building = extractBuilding(normalized) || 'Unknown Location';
  const issue = inferIssueFromText(normalized);
  const hasTechnician = /FULL\s+NAME\s+OF\s+THE\s+ELEVATOR\s+TECHNICIAN\s*[:\-]\s*.+/i.test(normalized);
  const hasArrival = /ACTUAL\s+TIME\s+OF\s+ARRIVAL\s*[:\-]\s*\d{1,2}:\d{2}/i.test(normalized);

  return {
    date,
    building,
    location: building,
    elevator,
    issue,
    status: hasTechnician && hasArrival ? 'Resolved' : 'Open',
    description: pickRelevantSentences(normalized, 2) || `Incident involving ${elevator}.`,
    notes: 'No additional notes.',
    reference: reference || 'N/A'
  };
}

// ── Merge Logic ─────────────────────────────────────────────────────────────
function mergeWithLocal(aiResult, text) {
  const local = parseLocal(text);
  const ai = aiResult || {};

  const cab = extractCab(text);
  const elevator = cabToElevator(cab) || local.elevator || ai.elevator;

  const type = detectType(text);
  let issue = type === 'incident_report' ? 'Entrapment' : (local.issue || ai.issue_type);

  const date = normalizeDate(local.date || ai.date) || new Date().toISOString().slice(0,10);
  const building = extractBuilding(text) || local.building || ai.building || 'Unknown Location';
  const reference = extractReference(text) || local.reference || 'N/A';
  const status = findOptionMatch(local.status || ai.status, STATS) || 'Open';
  const localShouldWin = /\[FORM FIELD\]/.test(text) || type === 'incident_report';

  let description = localShouldWin
    ? (local.description || String(ai.description || '').trim())
    : (String(ai.description || '').trim() || local.description);
  if (elevator && !description.includes(elevator)) {
    description = `${elevator} incident. ${description}`;
  }
  if (reference && !description.includes(reference)) {
    description = `${description} Reference: ${reference}.`;
  }

  const aiNotes = String(ai.resolution_notes || '').trim();
  const notes = localShouldWin
    ? (local.notes || aiNotes || 'No additional notes provided.')
    : (aiNotes || local.notes || 'No additional notes provided.');

  return { date, building, location: local.location || building, elevator, issue, status, description, notes, reference };
}

// ── Routes ─────────────────────────────────────────────────────────────────────
async function importPdfBuffer(buffer) {
  const parsed = await pdfParse(buffer);
  const pageText = normText(parsed.text || '');
  const formText = await extractPdfFormFieldText(buffer);
  const rawText = normText([pageText, formText].filter(Boolean).join('\n'));

  if (!rawText) {
    const error = new Error('No text extracted.');
    error.statusCode = 422;
    throw error;
  }

  console.log(`[pdf-import] ${rawText.length} chars | ${formText ? 'form fields found' : 'no form fields'} | Type: ${detectType(rawText)}`);

  let incident, warning = '';

  try {
    const ai = await callOpenAI(rawText);
    console.log('[pdf-import] AI succeeded');
    incident = mergeWithLocal(ai, rawText);
  } catch (err) {
    console.error('[pdf-import] AI failed:', err.message);
    incident = parseLocal(rawText);
    warning = `AI unavailable (${err.message}); used local fallback.`;
  }

  return { incident, warning, rawText: rawText.slice(0, 800) };
}

app.use(express.static(__dirname));

app.post('/api/pdf-import', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No PDF uploaded.' });
    res.json(await importPdfBuffer(file.buffer));
  } catch (err) {
    console.error('[pdf-import] fatal error:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

const port = parseInt(process.env.PORT || '8080', 10);

if (require.main === module) {
  app.listen(port, () => console.log(`LiftLog running on http://localhost:${port}`));
}

module.exports = {
  parseLocal,
  mergeWithLocal,
  extractPdfFormFieldText,
  importPdfBuffer,
  detectType,
  app
};
