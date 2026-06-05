// Go back to line 552
// line 543

//
// Core lookup lists used throughout filters, forms, charts, and exports.
const ELEVATOR_LETTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ELEVATOR_NUMBERS=Array.from({length:26},(_,i)=>String(i+1));
const ELEVS=[...ELEVATOR_LETTERS,...ELEVATOR_NUMBERS];
const ISSUES=['Entrapment','Door Issue','Mechanical Failure','Power Outage','Inspection Issue','Noise/Vibration','Other'];
const STATS=['Open','In Progress','Resolved'];
const MOS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MOSL=['January','February','March','April','May','June','July','August','September','October','November','December'];
const ICOLS={'Entrapment':'#4b5563','Door Issue':'#6b7280','Mechanical Failure':'#374151','Power Outage':'#9ca3af','Inspection Issue':'#111827','Noise/Vibration':'#d1d5db','Other':'#6b7280'};

// LocalStorage keys and import requirements.
const STORAGE_KEY='liftlog2';
const STORAGE_RESET_KEY='liftlog_cleared_v1';
const REQUIRED_IMPORT_FIELDS=['date','building','elevator','issue','status'];
const PDF_FIELD_LABELS={
  date:['date','incident date','report date','service date'],
  building:['building','location','site','property'],
  elevator:['elevator','lift','elevator id','lift id','unit'],
  issue:['issue type','incident type','issue','problem','event type'],
  status:['status','case status','incident status'],
  description:['description','incident description','summary','details','event summary'],
  notes:['resolution notes','notes','resolution','actions taken','corrective action','follow up']
};

const cssVar=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// Small DOM/data helpers to keep render functions focused on intent.
const $=id=>document.getElementById(id);
const setText=(id,value)=>{$(id).textContent=value};
const setHtml=(id,value)=>{$(id).innerHTML=value};
const countWhere=(rows,predicate)=>rows.reduce((sum,row)=>sum+(predicate(row)?1:0),0);
const getIncidentsByYear=year=>load().filter(row=>row.date.startsWith(year));
const formatElevatorLabel=elevator=>`Elevator ${elevator}`;
const isValidElevator=elevator=>ELEVS.includes(String(elevator||'').trim().toUpperCase());

//  Storage helpers 
const load=()=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]')}catch{return[]}};
const save=data=>localStorage.setItem(STORAGE_KEY,JSON.stringify(data));

function escapeRx(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}

const PDF_ALL_LABELS=Object.values(PDF_FIELD_LABELS).flat().map(escapeRx).join('|');

function normalizePdfText(text){
  return text
    .replace(/\r/g,'')
    .split('\n')
    .map(line=>line.replace(/\s+/g,' ').trim())
    .filter(Boolean)
    .join('\n');
}

function extractPdfPageText(items){
  // PDF.js gives positioned tokens; we group by Y then sort by X so label:value lines survive extraction.
  const rows=[];
  items.forEach(item=>{
    const value=(item.str||'').trim();
    if(!value)return;
    const y=Math.round(item.transform?.[5]||0);
    const x=item.transform?.[4]||0;
    const row=rows.find(entry=>Math.abs(entry.y-y)<=2);
    if(row){
      row.parts.push({x,value});
      return;
    }
    rows.push({y,parts:[{x,value}]});
  });

  return rows
    .sort((a,b)=>b.y-a.y)
    .map(row=>row.parts.sort((a,b)=>a.x-b.x).map(part=>part.value).join(' '))
    .join('\n');
}

function findLabeledValue(text, labels){
  for(const label of labels){
    const rx=new RegExp(`(?:^|\\n)${escapeRx(label)}\\s*[:\\-]\\s*(.+?)(?=\\n(?:${PDF_ALL_LABELS})\\s*[:\\-]|$)`,'is');
    const match=text.match(rx);
    if(match&&match[1])return match[1].trim();
  }
  return '';
}

function stripLabeledLines(text){
  if(!text)return '';
  const labelRx=new RegExp(`^(?:${PDF_ALL_LABELS})\\s*[:\\-]\\s*`,'i');
  return text
    .split('\n')
    .map(line=>line.trim())
    .filter(line=>line&&!labelRx.test(line))
    .join('\n')
    .trim();
}

function normalizeDate(raw){
  if(!raw)return '';
  const cleaned=raw.replace(/\./g,'/').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(cleaned))return cleaned;
  const slash=cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if(slash){
    const month=slash[1].padStart(2,'0');
    const day=slash[2].padStart(2,'0');
    const year=slash[3].length===2?`20${slash[3]}`:slash[3];
    return `${year}-${month}-${day}`;
  }
  const parsed=new Date(cleaned);
  return Number.isNaN(parsed.getTime())?'':parsed.toISOString().slice(0,10);
}

function cabNumberToLetter(value){
  const num=parseInt(value,10);
  if(Number.isNaN(num)||num<1||num>26)return '';
  return ELEVATOR_LETTERS[num-1];
}

function normalizeElevator(raw, mode='mixed'){
  if(!raw)return '';
  const cleaned=String(raw).trim().toUpperCase();
  const letter=cleaned.match(/\b([A-Z])\b/);
  const number=cleaned.match(/\b(2[0-6]|1\d|[1-9])\b/);

  if(mode==='letter'){
    if(letter&&isValidElevator(letter[1]))return letter[1];
    return number?cabNumberToLetter(number[1]):'';
  }

  if(mode==='numeric'){
    if(number)return String(parseInt(number[1],10));
    return '';
  }

  if(letter&&isValidElevator(letter[1]))return letter[1];
  if(number&&isValidElevator(String(parseInt(number[1],10))))return String(parseInt(number[1],10));
  return '';
}

function getElevatorUsage(rows){
  const counts={};
  rows.forEach(row=>{
    const token=normalizeElevator(row.elevator)||String(row.elevator||'').replace(/^Elevator\s+/i,'').trim();
    if(!token)return;
    counts[token]=(counts[token]||0)+1;
  });
  const order=value=>{
    const index=ELEVS.indexOf(value);
    return index>=0?index:ELEVS.length;
  };
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]||order(a[0])-order(b[0])||a[0].localeCompare(b[0]));
}

function findOptionMatch(raw, options){
  if(!raw)return '';
  const lowered=raw.toLowerCase();
  return options.find(option=>lowered.includes(option.toLowerCase()))||'';
}

function getFirstDate(text){
  const monthNames='jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
  const rx=new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b|\\b(?:${monthNames})\\s+\\d{1,2},?\\s+\\d{2,4}\\b`,'ig');
  const matches=[...text.matchAll(rx)];
  for(const match of matches){
    const normalized=normalizeDate(match[0]);
    if(normalized)return normalized;
  }
  return '';
}

function extractIncidentDate(text){
  const cleaned=text.replace(/(?:rev|wn)\s*\d{6,8}|\(Rev\s*\d{1,2}\/\d{1,2}\/\d{2,4}\)/ig,'');

  const patterns=[
    /\[FORM FIELD\]\s*DATE:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /\[FORM FIELD\]\s*Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /\bOn\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i,
    /\bOn\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i
  ];

  for(const rx of patterns){
    const match=cleaned.match(rx);
    if(match)return normalizeDate(match[1]);
  }

  return '';
}

function extractBuilding(text){
  if(/one buckhead plaza/i.test(text)||/\bOBP\b/i.test(text)){
    return 'One Buckhead Plaza';
  }
  return '';
}

function extractElevatorName(text){
  // "Service Elevator Cab #10" → return "10" (matches numeric dropdown)
  const serviceCab=text.match(/service\s+(?:elevator\s+)?cab\s*#?\s*(\d{1,2})/i);
  if(serviceCab)return serviceCab[1];

  // "CAB #: G" → return "G"
  const cabLetter=text.match(/\bCAB\s*#\s*[:\-]?\s*([A-Z])\b/i);
  if(cabLetter)return cabLetter[1].toUpperCase();

  // "CAB #: 10" → return "10"
  const cabNum=text.match(/\bCAB\s*#\s*[:\-]?\s*(\d{1,2})\b/i);
  if(cabNum)return cabNum[1];

  const locationField=text.match(/\[FORM FIELD\]\s*Location:\s*(.+)/i);
  if(locationField)return locationField[1].trim();

  return '';
}

function extractIncidentLocation(text){
  const floor=text.match(/(?:stuck on|on the|to the)\s+(\d{1,2})(?:st|nd|rd|th)?\s+floor/i);
  if(floor)return `${floor[1]}th Floor`;

  return '';
}

function extractPersonInvolved(text){
  const person=text.match(/\[FORM FIELD\]\s*Persons Involved NameDescriptionRow1:\s*(.+)/i);
  if(person)return person[1].trim();

  const identified=text.match(/identified as\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
  if(identified)return identified[1].trim();

  return '';
}

function buildCleanIncidentDescription(fields){
  const parts=[];

  if(fields.date&&fields.person&&fields.elevator&&fields.building){
    parts.push(
      `On ${fields.date}, ${fields.person} became trapped inside ${fields.elevator} at ${fields.building}.`
    );
  }

  if(fields.location){
    parts.push(
      `The elevator was reported stuck near the ${fields.location}, and security responded to the entrapment.`
    );
  }else{
    parts.push(
      'Security responded to the entrapment and contacted elevator service for assistance.'
    );
  }

  parts.push(
    'KONE responded, the individual was safely released without medical treatment, and the elevator was taken out of service after the cab shaft was found to be off track.'
  );

  return parts.join(' ');
}

function extractLocationValue(text){
  return findLabeledValue(text,['location of the problem','location'])||'';
}

function trimBoilerplate(text){
  if(!text)return '';
  const noisy=/^(incident report|elevator call log|marksman|page\s+\d+|date|time|client|location|cab\s*#|technician|signature|phone|email|address|site|property|status|issue type|description of incident|action\(s\) taken|actions taken|location of the problem|description of the problem)\b/i;
  return text
    .split('\n')
    .map(line=>line.replace(/\s+/g,' ').trim())
    .filter(line=>line&&line.length>8&&!noisy.test(line))
    .join(' ')
    .trim();
}

function pickRelevantSentences(text,maxSentences=2){
  const cleaned=trimBoilerplate(text);
  if(!cleaned)return '';
  const keys=/(elevator|lift|cab|stuck|trapped|entrap|door|fault|alarm|out of service|technician|rescue|release|repair|service|ticket|reference|returned to service)/i;
  const sentences=cleaned.split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);
  const relevant=sentences.filter(sentence=>keys.test(sentence));
  const chosen=(relevant.length?relevant:sentences).slice(0,maxSentences);
  return chosen.join(' ').replace(/\s+/g,' ').trim();
}

function summarizeDescription(text){
  // Keep description strictly as a short incident summary.
  return pickRelevantSentences(text,2);
}

function detectPdfType(text){
  if(/incident report/i.test(text))return 'incident_report';
  if(/elevator call log/i.test(text))return 'elevator_call_log';
  return 'generic';
}

function extractReferenceNumber(text){
  const patterns=[
    /(kone\s+service\s+ticket\s*#?\s*[a-z0-9-]+)/i,
    /(service\s+ticket\s*#?\s*[a-z0-9-]+)/i,
    /(reference\s*(?:number|no\.?|#)?\s*#?\s*[a-z0-9-]+)/i,
    /\b(?:ref(?:erence)?|ticket)\s*#\s*([a-z0-9-]{4,})\b/i,
    /#\s*([0-9]{6,})\b/
  ];
  for(const pattern of patterns){
    const match=text.match(pattern);
    if(match){
      const value=(match[1]||match[0]||'').replace(/\s+/g,' ').trim();
      if(value)return value;
    }
  }
  return '';
}

function getSection(text,startLabel,endLabels=[]){
  const source=`\n${text}`;
  const startRx=new RegExp(`\\n${escapeRx(startLabel)}\\s*:?\\s*`,'i');
  const startMatch=source.match(startRx);
  if(!startMatch)return '';
  const startIndex=(startMatch.index||0)+startMatch[0].length;
  const rest=source.slice(startIndex);
  let endIndex=rest.length;
  endLabels.forEach(label=>{
    const endRx=new RegExp(`\\n${escapeRx(label)}\\s*:?`,'i');
    const endMatch=rest.match(endRx);
    if(endMatch&&typeof endMatch.index==='number')endIndex=Math.min(endIndex,endMatch.index);
  });
  return rest.slice(0,endIndex).trim();
}

function summarizeLocal(text,maxSentences){
  if (!text) return '';
  const cleaned=text.replace(/\s+/g,' ').trim();
  if(!cleaned)return '';
  const sentences=cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  if(sentences.length<=maxSentences)return cleaned;
  return sentences.slice(0,maxSentences).join(' ');
}

function inferIssueFromDescription(text){
  const lowered=(text||'').toLowerCase();
  if(/door|closing|opening|sensor/.test(lowered))return 'Door Issue';
  if(/mechanical|motor|gear|brake|controller/.test(lowered))return 'Mechanical Failure';
  if(/power|outage|blackout|electric/.test(lowered))return 'Power Outage';
  if(/inspection|violation|code/.test(lowered))return 'Inspection Issue';
  if(/noise|vibration|rattle|shaking/.test(lowered))return 'Noise/Vibration';
  return 'Other';
}

function determineIncidentReportStatus(text){
  const lowered=text.toLowerCase();
  if(/out of service for the night|repair pending|pending repair|awaiting parts/.test(lowered))return 'Open';
  if(/occupant(?:s)? released|released safely|elevator cleared same day|returned to service/.test(lowered))return 'Resolved';
  return 'Open';
}

function determineCallLogStatus(text){
  const hasTechName=/technician\s*name\s*[:\-]\s*[^\n:]{2,}/i.test(text);
  const hasArrival=/actual\s+arrival\s+time\s*[:\-]\s*[^\n:]{2,}/i.test(text);
  return hasTechName&&hasArrival?'Resolved':'Open';
}

function ensureDescriptionHasRequirements(description,elevator,reference){
  let result=summarizeDescription(description);
  if(elevator&&!new RegExp(`\\b${escapeRx(formatElevatorLabel(elevator))}\\b`,'i').test(result)){
    result=`${formatElevatorLabel(elevator)} incident. ${result}`.trim();
  }
  if(reference&&!new RegExp(escapeRx(reference),'i').test(result)){
    result=`${result} Reference: ${reference}.`.trim();
  }
  return result.replace(/\s+/g,' ').trim();
}

function parseLocalByType(text){
  const normalized=normalizePdfText(text);
  const type=detectPdfType(normalized);
  const reference=extractReferenceNumber(normalized);
  const locationValue=extractLocationValue(normalized);

  if(type==='incident_report'){
    const date=extractIncidentDate(normalized);
    const building=extractBuilding(normalized);
    const elevator=extractElevatorName(normalized);
    const location=extractIncidentLocation(normalized);
    const person=extractPersonInvolved(normalized);
    const reference=extractReferenceNumber(normalized);

    const description=buildCleanIncidentDescription({
      date,
      building,
      elevator,
      location,
      person
    });

    const notesSection=getSection(normalized,'Action(s) Taken',['Technician','Signature','Date']);

    return {
      type,
      date,
      building,
      location,
      elevator,
      person,
      issue:'Entrapment',
      status:'Open',
      description:reference
        ?`${description} Service request/reference number: ${reference}.`
        :description,
      notes:pickRelevantSentences(notesSection,2),
      reference:reference||null
    };
  }

  if(type==='elevator_call_log'){
    const date=extractIncidentDate(normalized);

    const address=
      findLabeledValue(normalized,['location of the problem'])||
      normalized.match(/\[FORM FIELD\]\s*LOCATION OF THE PROBLEM:\s*(.+)/i)?.[1]||
      '';

    const cab=
      findLabeledValue(normalized,['cab'])||
      normalized.match(/\[FORM FIELD\]\s*CAB:\s*([A-Z0-9]+)/i)?.[1]||
      '';

    const problem=
      normalized.match(/\[FORM FIELD\]\s*DESCRIPTION OF THE PROBLEM:\s*(.+?)(?=\n\[FORM FIELD\])/is)?.[1]?.trim()||
      '';

    const techProblem=
      normalized.match(/\[FORM FIELD\]\s*DESCRIPTION OF THE PROBLEM_2:\s*(.+?)(?=\n\[FORM FIELD\])/is)?.[1]?.trim()||
      '';

    const reference=extractReferenceNumber(normalized);

    const floorMatch=problem.match(/on the\s+(\d{1,2})(?:st|nd|rd|th)?\s+floor/i);
    const floor=floorMatch?`${floorMatch[1]}th Floor`:'';

    const elevator=cab?`Elevator ${cab}`:'';

    const issue=
      /brake|break|switch|service|out of service|repair/i.test(problem+' '+techProblem)
        ?'Mechanical Failure'
        :inferIssueFromDescription(problem+' '+techProblem);

    const status=
      /actual time of arrival:\s*[^\n]+/i.test(normalized)||
      /technician/i.test(normalized)
        ?'Resolved'
        :'Open';

    const description=
      `On ${date}, ${elevator} at One Buckhead Plaza was reported out of service${floor?` on the ${floor}`:''}. `+
      `No entrapment was reported. KONE Elevator Service was contacted${reference?` and service ticket ${reference} was created`:''}. `+
      `${techProblem?`The technician reported: ${techProblem}.`:''}`;

    return {
      type,
      date,
      building:'One Buckhead Plaza',
      location:[address,floor].filter(Boolean).join(' / '),
      elevator,
      issue,
      status,
      description,
      notes:techProblem,
      reference
    };
  }

  const date=findLabeledValue(normalized,PDF_FIELD_LABELS.date)||extractIncidentDate(normalized);
  const building=locationValue||findLabeledValue(normalized,PDF_FIELD_LABELS.building);
  const elevator=findLabeledValue(normalized,PDF_FIELD_LABELS.elevator)||normalized.match(/(?:elevator|lift)\s*([a-z]|2[0-6]|1\d|[1-9])\b/i)?.[1]||'';
  const issue=findLabeledValue(normalized,PDF_FIELD_LABELS.issue)||findOptionMatch(normalized,ISSUES);
  const status=findLabeledValue(normalized,PDF_FIELD_LABELS.status)||findOptionMatch(normalized,STATS);
  const description=findLabeledValue(normalized,PDF_FIELD_LABELS.description)||stripLabeledLines(normalized);
  const notes=findLabeledValue(normalized,PDF_FIELD_LABELS.notes);

  return {
    type,
    date:normalizeDate(date),
    building,
    elevator:normalizeElevator(elevator),
    issue:findOptionMatch(issue,ISSUES),
    status:findOptionMatch(status,STATS),
    description:ensureDescriptionHasRequirements(description,normalizeElevator(elevator),reference),
    notes:pickRelevantSentences(notes,2),
    reference
  };
}

function mapAiResult(aiResult,rawText){
  const parsed=aiResult||{};
  const reference=extractReferenceNumber(rawText);
  const normalizedRaw=normalizePdfText(rawText);
  const issue=findOptionMatch(parsed.issue_type,ISSUES);
  const elevatorToken=normalizeElevator(String(parsed.elevator||'').replace(/elevator\s*/i,''),'letter')||normalizeElevator(parsed.elevator);
  const locationValue=extractLocationValue(normalizedRaw);
  return {
    date:normalizeDate(parsed.date||''),
    building:locationValue||(parsed.building||'').trim(),
    elevator:elevatorToken,
    issue:issue||'Other',
    status:findOptionMatch(parsed.status,STATS),
    description:ensureDescriptionHasRequirements((parsed.description||'').trim(),elevatorToken,reference),
    notes:pickRelevantSentences((parsed.resolution_notes||'').trim(),2),
    reference
  };
}

function showAddToast(kind,message){
  const toast=$('add-toast');
  toast.className=`toast ${kind} show`;
  toast.textContent=message;
  setTimeout(()=>toast.classList.remove('show'),4000);
}

function setImportStatus(kind,message){
  const status=$('pdf-status');
  status.className=`import-status ${kind}`;
  status.textContent=message;
}

function clearAutoFillHighlight(){
  document.querySelectorAll('.fgr').forEach(group=>group.classList.remove('auto-hit'));
}

function markAutoFillHighlight(record){
  const fieldToGroup={
    date:'f-date',
    building:'f-bld',
    elevator:'f-elev',
    issue:'f-issue',
    status:'f-stat',
    description:'f-desc',
    notes:'f-notes'
  };
  clearAutoFillHighlight();
  Object.entries(fieldToGroup).forEach(([key,id])=>{
    if(!record[key])return;
    const input=$(id);
    const group=input?.closest('.fgr');
    if(group)group.classList.add('auto-hit');
  });
}

function fillIncidentForm(record){
  // Always set date explicitly — never leave it as stale UI default
  $('f-date').value=record.date||new Date().toISOString().slice(0,10);
  if(record.building)$('f-bld').value=record.building;
  // Elevator: try exact match first (e.g. "Elevator G"), then partial
  if(record.elevator){
    const sel=$('f-elev');
    const label=formatElevatorLabel(record.elevator);
    // Check if the formatted label exists as an option
    const exactOpt=[...sel.options].find(o=>o.value===label||o.text===label);
    if(exactOpt){sel.value=exactOpt.value;}
    else{
      // Try matching just the token part (e.g. "G" or "10")
      const token=String(record.elevator).replace(/elevator\s*/i,'').trim();
      const tokenOpt=[...sel.options].find(o=>o.value===formatElevatorLabel(token)||o.text===formatElevatorLabel(token));
      if(tokenOpt)sel.value=tokenOpt.value;
    }
  }
  if(record.issue)$('f-issue').value=record.issue;
  if(record.status)$('f-stat').value=record.status;
  if(record.description)$('f-desc').value=record.description;
  if(record.notes)$('f-notes').value=record.notes;
  markAutoFillHighlight(record);
}

function pickNonEmpty(primary,fallback=''){
  const p=typeof primary==='string'?primary.trim():primary;
  if(p!==undefined&&p!==null&&p!=='')return p;
  const f=typeof fallback==='string'?fallback.trim():fallback;
  return f!==undefined&&f!==null?f:'';
}

function normalizeImportedIncident(incident){
  const rawElevator=String(incident.elevator||'').trim();

  let elevatorToken='';

  // Case 1: "Service Elevator Cab #10" or "Elevator Cab #10" → extract number → "10"
  const cabNumMatch=rawElevator.match(/cab\s*#?\s*(\d{1,2})/i);
  if(cabNumMatch){
    const n=parseInt(cabNumMatch[1],10);
    if(n>=1&&n<=26)elevatorToken=String(n);
  }

  // Case 2: "Elevator G" or "Elevator 10" → extract token after "Elevator "
  if(!elevatorToken){
    const afterElev=rawElevator.replace(/^Elevator\s+/i,'').trim();
    // If it's a plain number 1-26
    const numOnly=afterElev.match(/^(\d{1,2})$/);
    if(numOnly){
      const n=parseInt(numOnly[1],10);
      if(n>=1&&n<=26)elevatorToken=String(n);
    }
    // If it's a single letter A-Z
    const letterOnly=afterElev.match(/^([A-Z])$/i);
    if(!elevatorToken&&letterOnly)elevatorToken=letterOnly[1].toUpperCase();
  }

  // Case 3: raw token is just a number or letter
  if(!elevatorToken){
    elevatorToken=normalizeElevator(rawElevator)||'1';
  }

  const normalizedBuilding=String(incident.building||incident.location||'').trim();
  const date=normalizeDate(incident.date||'')||new Date().toISOString().slice(0,10);
  const issue=findOptionMatch(incident.issue,ISSUES)||'Other';
  const status=findOptionMatch(incident.status,STATS)||'Open';

  console.log(`[normalize] elevator raw="${rawElevator}" token="${elevatorToken}" issue="${issue}" status="${status}" date="${date}"`);

  return {
    ...incident,
    date,
    building:normalizedBuilding||'Unknown Location',
    location:String(incident.location||'').trim()||normalizedBuilding||'Unknown Location',
    elevator:elevatorToken,
    issue,
    status,
    description:String(incident.description||'').trim()||'Incident imported from PDF.',
    notes:String(incident.notes||'').trim()||'No additional notes provided.'
  };
}

function applyImportDefaults(incident){
  return {
    ...incident,
    date:incident.date||new Date().toISOString().slice(0,10),
    building:incident.building||incident.location||'Unknown Location',
    elevator:incident.elevator||'1',
    issue:incident.issue||'Other',
    status:incident.status||'Open',
    description:incident.description||'Incident imported from PDF and summarized.',
    notes:incident.notes||'No additional notes provided.'
  };
}

function clearIncidentForm(){
  $('f-date').value=new Date().toISOString().slice(0,10);
  $('f-bld').value='';
  $('f-elev').selectedIndex=0;
  $('f-issue').selectedIndex=0;
  $('f-stat').value='Open';
  $('f-desc').value='';
  $('f-notes').value='';
  clearAutoFillHighlight();
  setImportStatus('', 'Ready for a single incident report PDF.');
}

async function processPdfFile(file){
  if(!file)return;
  if(file.type!=='application/pdf'&&!file.name.toLowerCase().endsWith('.pdf')){
    setImportStatus('fail','Only .pdf files are supported.');
    showAddToast('err','Upload a PDF file only.');
    return;
  }

  try{
    setImportStatus('loading','Uploading PDF...');
    const formData=new FormData();
    formData.append('file',file);
    const response=await fetch('/api/pdf-import',{method:'POST',body:formData});
    if(!response.ok){
      const errorData=await response.json().catch(()=>({}));
      throw new Error(errorData.error||`Server error ${response.status}`);
    }

    const payload=await response.json();
    console.log('[pdf-import] payload received',JSON.stringify(payload.incident));

    let incident=payload.incident||{};

    // Show warning if AI fell back
    if(payload.warning){
      console.warn('[pdf-import] server warning:',payload.warning);
    }

    incident=normalizeImportedIncident(incident);
    incident=applyImportDefaults(incident);

    console.log('[pdf-import] final normalized incident',JSON.stringify(incident));

    const filledCount=Object.values(incident).filter(v=>v&&v!=='Unknown Location'&&v!=='No additional notes provided.').length;
    fillIncidentForm(incident);
    setImportStatus('done',`${filledCount} fields auto-filled${payload.warning?' (AI unavailable, used local parser)':''}. Review and click Save.`);
    showAddToast(payload.warning?'info':'ok','PDF imported. Review the form and click Save Incident.');
  }catch(error){
    console.error('[pdf-import] failed',error.message);
    setImportStatus('fail',`Import failed: ${error.message}`);
    showAddToast('err',`PDF import failed: ${error.message}`);
  }
}



//  Year dropdown 
function buildYearList(){
  const thisYear=new Date().getFullYear();
  const dataYears=new Set(load().map(r=>r.date.slice(0,4)));
  const yrs=new Set();
  for(let y=2020;y<=2035;y++)yrs.add(String(y));
  dataYears.forEach(y=>yrs.add(y));
  return [...yrs].sort((a,b)=>b-a);
}

function initYrDrop(){
  const yrs=buildYearList();
  const sel=$('gyr');
  const cur=sel.value||String(new Date().getFullYear());
  sel.innerHTML=yrs.map(y=>`<option value="${y}">${y}</option>`).join('');
  sel.value=yrs.includes(cur)?cur:String(new Date().getFullYear());
}

const getYr=()=>$('gyr').value;

//  Page navigation 
function go(id){
  document.querySelectorAll('.pg').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.ni').forEach(b=>b.classList.remove('on'));
  $('pg-'+id).classList.add('on');
  document.querySelectorAll('.ni')[['dash','add','log','trap','dl'].indexOf(id)].classList.add('on');
  if(id==='dash')renderDash();
  if(id==='log')renderLog();
  if(id==='trap')renderTrap();
  if(id==='dl')renderDL();
}

function refresh(){renderDash();renderLog();renderTrap();renderDL()}

//  Dashboard 
function renderDash(){
  const yr=getYr();
  const data=getIncidentsByYear(yr);
  const trap=countWhere(data,row=>row.issue==='Entrapment');
  setText('dash-sub',`${data.length} incidents recorded in ${yr}`);
  setText('k-tot',data.length);
  setText('k-tr',trap);
  setText('k-ot',data.length-trap);
  setText('k-op',countWhere(data,row=>row.status==='Open'));
  setText('k-ip',countWhere(data,row=>row.status==='In Progress'));
  setText('k-re',countWhere(data,row=>row.status==='Resolved'));

  const elevatorUsage=getElevatorUsage(data);
  const top=elevatorUsage[0];
  setText('top-elev',top&&top[1]>0?`${formatElevatorLabel(top[0])} - ${top[1]} incidents`:'No incidents yet');

  const maxE=Math.max(1,...elevatorUsage.map(([,v])=>v));
  setHtml('elev-bars',elevatorUsage.length
    ?elevatorUsage.map(([l,v])=>`<div class="br"><div class="bl">${formatElevatorLabel(l)}</div><div class="bt"><div class="bf" style="width:${Math.round(v/maxE*100)}%"></div></div><div class="bc">${v}</div></div>`).join('')
    :'<div style="color:var(--tx3);font-size:13px;padding:6px">No elevator incidents recorded for this year.</div>');

  const ic={};ISSUES.forEach(t=>ic[t]=0);data.forEach(r=>ic[r.issue]=(ic[r.issue]||0)+1);
  drawPie(ic,data.length);

  const mc={};for(let i=0;i<12;i++)mc[i]=0;data.forEach(r=>{const m=parseInt(r.date.slice(5,7))-1;mc[m]=(mc[m]||0)+1});
  const maxM=Math.max(1,...Object.values(mc));
  const trendOn=cssVar('--blue')||'#4b5563';
  const trendOff=cssVar('--bdr')||'#9ca3af';
  setHtml('trend',Object.values(mc).map(v=>`<div class="tc"><div class="tb" style="height:${Math.round(v/maxM*88)+2}px;background:${v?trendOn:trendOff}"></div></div>`).join(''));
  setHtml('trend-lbl',MOS.map(m=>`<div style="flex:1;text-align:center;font-size:9px;color:var(--tx3);font-family:var(--fh)">${m}</div>`).join(''));
}

function drawPie(ic,tot){
  const cv=$('pie-c'),ctx=cv.getContext('2d');
  const pieEmpty=cssVar('--bdr')||'#9ca3af';
  const pieCenter=cssVar('--surf')||'#f3f4f6';
  ctx.clearRect(0,0,160,160);
  const entries=Object.entries(ic).filter(([,v])=>v>0);
  if(!entries.length){ctx.fillStyle=pieEmpty;ctx.beginPath();ctx.arc(80,80,62,0,2*Math.PI);ctx.fill();}
  else{
    let s=-Math.PI/2;
    entries.forEach(([k,v])=>{const sl=(v/tot)*2*Math.PI;ctx.beginPath();ctx.moveTo(80,80);ctx.arc(80,80,62,s,s+sl);ctx.fillStyle=ICOLS[k]||'#5c637a';ctx.fill();s+=sl});
    ctx.beginPath();ctx.arc(80,80,34,0,2*Math.PI);ctx.fillStyle=pieCenter;ctx.fill();
  }
  setHtml('pie-leg',entries.map(([k,v])=>`
  <div class="pi"><div class="pd" style="background:${ICOLS[k]}"></div><div class="pn">${k}</div><div class="pv">${v} <span class="ppc">
  ${tot?Math.round(v/tot*100):0}%</span></div></div>`).join(''));
}

//  Badge helpers 
function bClass(i){const m={'Entrapment':'entr','Door Issue':'door','Mechanical Failure':'mech','Power Outage':'powr'};return'b-'+(m[i]||'othr')}
function sClass(s){return s==='Open'?'b-open':s==='In Progress'?'b-prog':'b-res'}

function updateIncidentStatus(id,status){
  const data=load();
  const incident=data.find(row=>row.id===id);
  if(!incident)return;
  const normalized=findOptionMatch(status,STATS);
  if(!normalized||incident.status===normalized)return;
  incident.status=normalized;
  save(data);
  showAddToast('ok',`Incident #${id} status updated to ${normalized}.`);
  refresh();
}

function deleteIncident(id){
  const data=load();
  const incident=data.find(row=>row.id===id);
  if(!incident)return;
  const confirmed=window.confirm(`Delete incident #${id}? This cannot be undone.`);
  if(!confirmed)return;
  const updated=data.filter(row=>row.id!==id);
  save(updated);
  showAddToast('ok',`Incident #${id} deleted.`);
  initYrDrop();
  initFilters();
  refresh();
}

function clearIncidentLog(){
  const data=load();
  if(!data.length){
    showAddToast('info','Incident log is already empty.');
    return;
  }
  const confirmed=window.confirm('Clear the entire incident log? This cannot be undone.');
  if(!confirmed)return;
  save([]);
  showAddToast('ok','Incident log cleared.');
  initYrDrop();
  initFilters();
  refresh();
}

//  Incident Log 
function renderLog(){
  let data=load();
  const fy=$('lf-yr').value,fm=$('lf-mo').value,
        fe=$('lf-el').value,fi=$('lf-is').value,
        fs=$('lf-st').value,fq=($('lf-q').value||'').toLowerCase();
  if(fy)data=data.filter(r=>r.date.startsWith(fy));
  if(fm)data=data.filter(r=>parseInt(r.date.slice(5,7))===parseInt(fm));
  if(fe)data=data.filter(r=>r.elevator===fe);
  if(fi)data=data.filter(r=>r.issue===fi);
  if(fs)data=data.filter(r=>r.status===fs);
  if(fq)data=data.filter(r=>(r.building||'').toLowerCase().includes(fq)||(r.description||'').toLowerCase().includes(fq)||(r.notes||'').toLowerCase().includes(fq));
  data.sort((a,b)=>b.date.localeCompare(a.date));
  setText('log-cnt',data.length);
  setHtml('log-body',data.length
    ?data.map(r=>`<tr><td>${r.id}</td><td>${r.date}</td><td>${r.building||'-'}</td><td>${formatElevatorLabel(r.elevator)}</td><td><span class="badge ${bClass(r.issue)}">${r.issue}</span></td><td class="log-desc">${r.description||'-'}</td><td><select class="status-edit ${sClass(r.status)}" aria-label="Update status for incident ${r.id}" onchange="updateIncidentStatus(${r.id},this.value)">${STATS.map(status=>`<option value="${status}" ${status===r.status?'selected':''}>${status}</option>`).join('')}</select></td><td><button type="button" class="row-del" aria-label="Delete incident ${r.id}" onclick="deleteIncident(${r.id})"><i class="ti ti-trash"></i>Delete</button></td></tr>`).join('')
    :`<tr><td colspan="8"><div class="nd"><i class="ti ti-mood-empty"></i>No incidents match your filters.</div></td></tr>`);
}

//  Entrapment Tracker 
function renderTrap(){
  const yr=getYr();
  const data=getIncidentsByYear(yr).filter(r=>r.issue==='Entrapment');
  setText('trap-sub',`Passenger entrapments for ${yr}`);
  setText('tr-tot',data.length);
  setText('tr-op',countWhere(data,row=>row.status==='Open'));
  setText('tr-re',countWhere(data,row=>row.status==='Resolved'));
  const elevatorUsage=getElevatorUsage(data);
  const maxE=Math.max(1,...elevatorUsage.map(([,v])=>v));
  setHtml('trap-bars',elevatorUsage.length
    ?elevatorUsage.map(([l,v])=>`<div class="br"><div class="bl">${formatElevatorLabel(l)}</div><div class="bt"><div class="bf re" style="width:${Math.round(v/maxE*100)}%"></div></div><div class="bc">${v}</div></div>`).join('')
    :'<div style="color:var(--tx3);font-size:13px;padding:6px">No entrapments recorded for this year.</div>');
  data.sort((a,b)=>b.date.localeCompare(a.date));
  setHtml('trap-body',data.length
    ?data.map(r=>`<tr><td>${r.id}</td><td>${r.date}</td><td>${r.building||'-'}</td><td>${formatElevatorLabel(r.elevator)}</td><td class="log-desc">${r.description||'-'}</td><td><span class="badge ${sClass(r.status)}">${r.status}</span></td><td class="log-notes">${r.notes||'-'}</td></tr>`).join('')
    :`<tr><td colspan="7"><div class="nd"><i class="ti ti-circle-check"></i>No entrapments this year.</div></td></tr>`);
}

//  Download page 
function renderDL(){
  const yr=getYr();
  const data=getIncidentsByYear(yr);
  setText('dl-tot',data.length);
  setText('dl-tr',countWhere(data,row=>row.issue==='Entrapment'));
  setText('dl-op',countWhere(data,row=>row.status==='Open'));
}

function estimateWrappedLineCount(text,colWidth){
  const content=String(text||'');
  if(!content)return 1;
  const hardLines=content.split('\n');
  return hardLines.reduce((total,line)=>{
    const length=Math.max(1,line.length);
    return total+Math.max(1,Math.ceil(length/Math.max(10,colWidth)));
  },0);
}

function wrapTextForExcel(value,maxChars){
  const content=String(value||'').replace(/\r/g,'').trim();
  if(!content)return '';
  return content
    .split('\n')
    .map(paragraph=>{
      const words=paragraph.trim().split(/\s+/).filter(Boolean);
      if(!words.length)return '';
      const lines=[];
      let line='';
      words.forEach(word=>{
        const next=line?`${line} ${word}`:word;
        if(next.length<=maxChars){
          line=next;
        }else{
          if(line)lines.push(line);
          line=word;
        }
      });
      if(line)lines.push(line);
      return lines.join('\n');
    })
    .join('\n')
    .trim();
}

function applyWrappedTextColumns(ws,rowCount,columnConfig){
  if(!ws||!rowCount)return;
  ws['!rows']=ws['!rows']||[];
  ws['!rows'][0]={hpt:20};

  for(let i=0;i<rowCount;i++){
    const rowNumber=i+2;
    let maxLines=1;

    columnConfig.forEach(({col,width})=>{
      const cellRef=`${col}${rowNumber}`;
      const cell=ws[cellRef];
      if(!cell)return;
      cell.s={...(cell.s||{}),alignment:{...(cell.s?.alignment||{}),wrapText:true,vertical:'top'}};
      maxLines=Math.max(maxLines,estimateWrappedLineCount(cell.v,width));
    });

    ws['!rows'][rowNumber-1]={hpt:Math.max(22,maxLines*13)};
  }
}

//  Excel Export with embedded charts 
function exportXLSX(){
  const yr=getYr();
  const data=getIncidentsByYear(yr);
  const btn=$('xl-btn');
  const status=$('xl-status');
  btn.disabled=true;
  status.className='xl-status loading';
  status.textContent='Building workbook with charts...';

  try{
    const WB=XLSX.utils.book_new();

    //  Sheet 1: Incident Log 
  const logRows=data.map(r=>({'ID':r.id,'Date':r.date,'Building':r.building||'','Elevator':formatElevatorLabel(r.elevator),'Issue Type':r.issue,'Description':wrapTextForExcel(r.description||'',56),'Status':r.status,'Resolution Notes':wrapTextForExcel(r.notes||'',46)}));
    const wsLog=XLSX.utils.json_to_sheet(logRows.length?logRows:[{'Note':'No incidents for '+yr}]);
    wsLog['!cols']=[{wch:6},{wch:12},{wch:20},{wch:13},{wch:20},{wch:56},{wch:14},{wch:44}];
    applyWrappedTextColumns(wsLog,logRows.length,[{col:'F',width:56},{col:'H',width:44}]);
    wsLog['!freeze']={xSplit:0,ySplit:1};
    XLSX.utils.book_append_sheet(WB,wsLog,'Incident_Log');

    //  Sheet 2: Entrapments 
    const trapRows=data.filter(r=>r.issue==='Entrapment').map(r=>({'ID':r.id,'Date':r.date,'Building':r.building||'','Elevator':formatElevatorLabel(r.elevator),'Description':wrapTextForExcel(r.description||'',56),'Status':r.status,'Resolution Notes':wrapTextForExcel(r.notes||'',46)}));
    const wsTrap=XLSX.utils.json_to_sheet(trapRows.length?trapRows:[{'Note':'No entrapments for '+yr}]);
    wsTrap['!cols']=[{wch:6},{wch:12},{wch:20},{wch:13},{wch:56},{wch:14},{wch:44}];
    applyWrappedTextColumns(wsTrap,trapRows.length,[{col:'E',width:56},{col:'G',width:44}]);
    XLSX.utils.book_append_sheet(WB,wsTrap,'Entrapments');

    //  Sheet 3: Monthly Summary 
    const mc={};for(let i=0;i<12;i++)mc[i]={Month:MOSL[i],'Total Incidents':0,'Entrapments':0,'Open':0,'In Progress':0,'Resolved':0};
    data.forEach(r=>{const m=parseInt(r.date.slice(5,7))-1;mc[m]['Total Incidents']++;if(r.issue==='Entrapment')mc[m]['Entrapments']++;mc[m][r.status]=(mc[m][r.status]||0)+1});
    const wsMo=XLSX.utils.json_to_sheet(Object.values(mc));
    wsMo['!cols']=[{wch:14},{wch:16},{wch:14},{wch:10},{wch:13},{wch:10}];
    XLSX.utils.book_append_sheet(WB,wsMo,'Monthly_Summary');

    //  Sheet 4: Chart_Data (hidden source data for charts) 
    const ec={};ELEVS.forEach(l=>ec[l]=0);data.forEach(r=>ec[r.elevator]=(ec[r.elevator]||0)+1);
    const ic={};ISSUES.forEach(t=>ic[t]=0);data.forEach(r=>ic[r.issue]=(ic[r.issue]||0)+1);
    const mCounts=Object.values(mc).map(r=>r['Total Incidents']);

    const activeElevators=Object.entries(ec)
      .filter(([,count])=>count>0)
      .sort((a,b)=>b[1]-a[1]||ELEVS.indexOf(a[0])-ELEVS.indexOf(b[0]));
    const elevatorChartRows=(activeElevators.length?activeElevators:Object.entries(ec).slice(0,8)).slice(0,12);
    const issueSummary=Object.entries(ic)
      .sort((a,b)=>b[1]-a[1]||ISSUES.indexOf(a[0])-ISSUES.indexOf(b[0]));
    const issueChartRows=issueSummary.filter(([,count])=>count>0);
    if(!issueChartRows.length)issueChartRows.push(['No incidents',1]);

    // Chart data sheet layout:
    // A1:B13  = Top elevator data (label | count)
    // C1:D?   = Active issue type data (label | count)
    // E1:F13  = Monthly trend data (label | count)
    const chartRows=Math.max(elevatorChartRows.length,issueChartRows.length,MOS.length);
    const chartDataAoA=[['Elevator','Incidents','Issue Type','Count','Month','Incidents']];
    for(let i=0;i<chartRows;i++){
      chartDataAoA.push([
        elevatorChartRows[i]?formatElevatorLabel(elevatorChartRows[i][0]):'',
        elevatorChartRows[i]?elevatorChartRows[i][1]:'',
        issueChartRows[i]?issueChartRows[i][0]:'',
        issueChartRows[i]?issueChartRows[i][1]:'',
        MOS[i]||'',
        typeof mCounts[i]==='number'?mCounts[i]:''
      ]);
    }
    const wsCD=XLSX.utils.aoa_to_sheet(chartDataAoA);
    wsCD['!cols']=[{wch:20},{wch:10},{wch:20},{wch:10},{wch:10},{wch:10}];
    XLSX.utils.book_append_sheet(WB,wsCD,'Chart_Data');

    //  Sheet 5: Dashboard (KPIs + charts anchored here) 
    const trap=data.filter(r=>r.issue==='Entrapment').length;
    const topE=(activeElevators[0]||Object.entries(ec).sort((a,b)=>b[1]-a[1])[0]);
    const topElevatorsTable=[...elevatorChartRows];
    while(topElevatorsTable.length<6)topElevatorsTable.push(['', '']);
    const issueTable=[...issueSummary.slice(0,6)];
    while(issueTable.length<6)issueTable.push(['', '']);
    const dashAoA=[
      [`LiftLog Annual Report - ${yr}`,'','','','','','',''],
      [`Generated: ${new Date().toLocaleString()}`,'','','','','','',''],
      ['','','','','','','',''],
      ['METRIC','VALUE','','Top Elevators','Incidents','','Issue Breakdown','Count'],
      ['Total Incidents',data.length,'',topElevatorsTable[0][0]?formatElevatorLabel(topElevatorsTable[0][0]):'',topElevatorsTable[0][1],'',issueTable[0][0],issueTable[0][1]],
      ['Entrapments',trap,'',topElevatorsTable[1][0]?formatElevatorLabel(topElevatorsTable[1][0]):'',topElevatorsTable[1][1],'',issueTable[1][0],issueTable[1][1]],
      ['Other Incidents',data.length-trap,'',topElevatorsTable[2][0]?formatElevatorLabel(topElevatorsTable[2][0]):'',topElevatorsTable[2][1],'',issueTable[2][0],issueTable[2][1]],
      ['Open Cases',data.filter(r=>r.status==='Open').length,'',topElevatorsTable[3][0]?formatElevatorLabel(topElevatorsTable[3][0]):'',topElevatorsTable[3][1],'',issueTable[3][0],issueTable[3][1]],
      ['In Progress',data.filter(r=>r.status==='In Progress').length,'',topElevatorsTable[4][0]?formatElevatorLabel(topElevatorsTable[4][0]):'',topElevatorsTable[4][1],'',issueTable[4][0],issueTable[4][1]],
      ['Resolved',data.filter(r=>r.status==='Resolved').length,'',topElevatorsTable[5][0]?formatElevatorLabel(topElevatorsTable[5][0]):'',topElevatorsTable[5][1],'',issueTable[5][0],issueTable[5][1]],
      ['Elevator With Most Incidents',topE&&topE[1]>0?`${formatElevatorLabel(topE[0])} (${topE[1]} incidents)`:'N/A','','','','','',''],
    ];
    const wsDash=XLSX.utils.aoa_to_sheet(dashAoA);
    wsDash['!cols']=[{wch:34},{wch:24},{wch:3},{wch:24},{wch:11},{wch:3},{wch:22},{wch:10}];
    wsDash['!merges']=[{s:{r:0,c:0},e:{r:0,c:7}},{s:{r:1,c:0},e:{r:1,c:7}}];
    wsDash['!rows']=[{hpt:26},{hpt:20},{hpt:8},{hpt:20}];

    const dashTitleStyle={font:{bold:true,sz:15,color:{rgb:'1F2937'}},alignment:{horizontal:'left',vertical:'center'}};
    const dashSubTitleStyle={font:{bold:false,sz:10,color:{rgb:'6B7280'}},alignment:{horizontal:'left',vertical:'center'}};
    const dashHeaderStyle={font:{bold:true,color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'374151'}},alignment:{horizontal:'left',vertical:'center'}};
    const dashValueStyle={alignment:{horizontal:'right',vertical:'center'}};

    if(wsDash.A1)wsDash.A1.s=dashTitleStyle;
    if(wsDash.A2)wsDash.A2.s=dashSubTitleStyle;
    ['A4','B4','D4','E4','G4','H4'].forEach(cell=>{if(wsDash[cell])wsDash[cell].s=dashHeaderStyle;});
    ['B5','B6','B7','B8','B9','B10','E5','E6','E7','E8','E9','E10','H5','H6','H7','H8','H9','H10'].forEach(cell=>{if(wsDash[cell])wsDash[cell].s=dashValueStyle;});
    XLSX.utils.book_append_sheet(WB,wsDash,'Dashboard');

    // SheetJS can write sheets quickly, but embedded charts need manual OpenXML parts.
    // We patch the generated .xlsx zip with drawing/chart XML and relationships.

    const elevEndRow=elevatorChartRows.length+1;
    const issueEndRow=issueChartRows.length+1;
    // Bar chart: Incidents by Elevator (Chart_Data A2:B?)
    const barChartXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Incidents by Elevator</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:f>Chart_Data!$B$1</c:f></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>Chart_Data!$A$2:$A$${elevEndRow}</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Chart_Data!$B$2:$B$${elevEndRow}</c:f></c:numRef></c:val>
        </c:ser>
        <c:axId val="1"/><c:axId val="2"/>
      </c:barChart>
      <c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>
      <c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>
  </c:chart>
</c:chartSpace>`;

    // Pie chart: Issue Type Breakdown (Chart_Data C2:D?)
    const pieChartXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Incidents by Issue Type</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:pieChart>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:f>Chart_Data!$D$1</c:f></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>Chart_Data!$C$2:$C$${issueEndRow}</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Chart_Data!$D$2:$D$${issueEndRow}</c:f></c:numRef></c:val>
        </c:ser>
        <c:firstSliceAng val="0"/>
      </c:pieChart>
    </c:plotArea>
    <c:legend><c:legendPos val="b"/></c:legend>
  </c:chart>
</c:chartSpace>`;

    // Line chart: Monthly Trend (Chart_Data E2:F13)
    const lineChartXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Monthly Incident Trend</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:lineChart>
        <c:grouping val="standard"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:f>Chart_Data!$F$1</c:f></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>Chart_Data!$E$2:$E$13</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Chart_Data!$F$2:$F$13</c:f></c:numRef></c:val>
          <c:marker><c:symbol val="circle"/></c:marker>
          <c:smooth val="0"/>
        </c:ser>
        <c:axId val="1"/><c:axId val="2"/>
      </c:lineChart>
      <c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>
      <c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="b"/></c:legend>
  </c:chart>
</c:chartSpace>`;

    // Drawing XML: anchors 3 charts onto the Dashboard sheet
    const drawingXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>27</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>
      <xdr:cNvPr id="2" name="Bar Chart"/><xdr:cNvGraphicFramePr/>
    </xdr:nvGraphicFramePr>
    <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
      <c:chart r:id="rId1"/>
    </a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/>
  </xdr:twoCellAnchor>
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>11</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>18</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>27</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>
      <xdr:cNvPr id="3" name="Pie Chart"/><xdr:cNvGraphicFramePr/>
    </xdr:nvGraphicFramePr>
    <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
      <c:chart r:id="rId2"/>
    </a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/>
  </xdr:twoCellAnchor>
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>28</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>18</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>43</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>
      <xdr:cNvPr id="4" name="Line Chart"/><xdr:cNvGraphicFramePr/>
    </xdr:nvGraphicFramePr>
    <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
      <c:chart r:id="rId3"/>
    </a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;

    // Relationships for the drawing (links drawing  chart files)
    const drawingRelsXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart3.xml"/>
</Relationships>`;

    // Write base workbook, then reopen as zip for chart/drawing injection.
    const wbOut=XLSX.write(WB,{type:'binary',bookType:'xlsx',cellStyles:true});

      // Convert binary string  Uint8Array for JSZip
      // I need to come back to this 
    const s2ab=s=>{const b=new ArrayBuffer(s.length);const v=new Uint8Array(b);for(let i=0;i<s.length;i++)v[i]=s.charCodeAt(i)&0xFF;return b};

    // Lazy-load JSZip only when exporting to keep initial app load light.
    const script=document.createElement('script');
    script.src='https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    script.onload=async()=>{
      const zip=await JSZip.loadAsync(s2ab(wbOut));

      // Dashboard is the 5th appended sheet, so it maps to xl/worksheets/sheet5.xml.
      const dashSheetFile='xl/worksheets/sheet5.xml';
      const dashRelsDir='xl/worksheets/_rels/sheet5.xml.rels';

      // Patch the Dashboard sheet XML to reference the drawing
      let dashXml=await zip.file(dashSheetFile).async('string');
      if(!dashXml.includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')){
        dashXml=dashXml.replace('<worksheet ','<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
      }
      if(!dashXml.includes('<drawing')){
        dashXml=dashXml.replace('</worksheet>','<drawing r:id="rId100"/></worksheet>');
        zip.file(dashSheetFile,dashXml);
      }

      // Add/update the Dashboard sheet's .rels to include the drawing relationship
      let dashRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId100" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
      zip.file(dashRelsDir,dashRels);

      // Add chart files
      zip.file('xl/charts/chart1.xml',barChartXml);
      zip.file('xl/charts/chart2.xml',pieChartXml);
      zip.file('xl/charts/chart3.xml',lineChartXml);

      // Add drawing file and its rels
      zip.file('xl/drawings/drawing1.xml',drawingXml);
      zip.file('xl/drawings/_rels/drawing1.xml.rels',drawingRelsXml);

      // Patch [Content_Types].xml to register new parts
      let ct=await zip.file('[Content_Types].xml').async('string');
      const ctPatches=[
        ['xl/charts/chart1.xml','application/vnd.openxmlformats-officedocument.drawingml.chart+xml'],
        ['xl/charts/chart2.xml','application/vnd.openxmlformats-officedocument.drawingml.chart+xml'],
        ['xl/charts/chart3.xml','application/vnd.openxmlformats-officedocument.drawingml.chart+xml'],
        ['xl/drawings/drawing1.xml','application/vnd.openxmlformats-officedocument.drawing+xml'],
      ];
      ctPatches.forEach(([pn,ct_])=>{
        if(!ct.includes(pn)){
          ct=ct.replace('</Types>',`<Override PartName="/${pn}" ContentType="${ct_}"/></Types>`);
        }
      });
      zip.file('[Content_Types].xml',ct);

      // Generate final blob and trigger download
      const blob=await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=`LiftLog_${yr}_Report.xlsx`;
      a.click();

      status.className='xl-status done';
      status.textContent=`LiftLog_${yr}_Report.xlsx downloaded - open in Excel to see charts.`;
      btn.disabled=false;
    };
    script.onerror=()=>{
      status.className='xl-status fail';
      status.textContent='Could not load JSZip. Check your internet connection.';
      btn.disabled=false;
    };
    document.head.appendChild(script);
    return; // async path handles btn.disabled
  }catch(e){
    status.className='xl-status fail';
    status.textContent='Export failed: '+e.message;
    btn.disabled=false;
  }
}

//  CSV fallback 
function exportCSV(){
  const yr=getYr();
  const data=getIncidentsByYear(yr);
  const hdr=['ID','Date','Building','Elevator','Issue Type','Description','Status','Resolution Notes'];
  const esc=v=>typeof v==='string'&&(v.includes(',')||v.includes('"'))?`"${v.replace(/"/g,'""')}"`:(v||'');
  const rows=data.map(r=>[r.id,r.date,esc(r.building||''),formatElevatorLabel(r.elevator),r.issue,esc(r.description||''),r.status,esc(r.notes||'')]);
  const csv=[hdr.join(','),...rows.map(r=>r.join(','))].join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`LiftLog_${yr}.csv`;a.click();
}

async function exportPDF(){
  const yr=getYr();
  const data=getIncidentsByYear(yr).sort((a,b)=>b.date.localeCompare(a.date));
  const entrapments=data.filter(row=>row.issue==='Entrapment');
  const btn=$('pdf-btn');
  const status=$('xl-status');
  btn.disabled=true;
  status.className='xl-status loading';
  status.textContent='Building PDF report...';

  try{
    if(!window.jspdf||typeof window.jspdf.jsPDF!=='function'){
      throw new Error('PDF library is unavailable. Refresh the page and try again.');
    }

    const {jsPDF}=window.jspdf;
    const doc=new jsPDF({orientation:'landscape',unit:'pt',format:'a4'});

    const title=`LiftLog Annual Report - ${yr}`;
    const generated=`Generated: ${new Date().toLocaleString()}`;
    const metricRows=[
      ['Total Incidents',String(data.length)],
      ['Entrapments',String(countWhere(data,row=>row.issue==='Entrapment'))],
      ['Other Incidents',String(countWhere(data,row=>row.issue!=='Entrapment'))],
      ['Open Cases',String(countWhere(data,row=>row.status==='Open'))],
      ['In Progress',String(countWhere(data,row=>row.status==='In Progress'))],
      ['Resolved',String(countWhere(data,row=>row.status==='Resolved'))]
    ];

    const elevatorCounts={};
    ELEVS.forEach(elevator=>{elevatorCounts[elevator]=0;});
    data.forEach(row=>{
      if(elevatorCounts[row.elevator]!==undefined)elevatorCounts[row.elevator]+=1;
    });

    const issueCounts={};
    ISSUES.forEach(issue=>{issueCounts[issue]=0;});
    data.forEach(row=>{issueCounts[row.issue]=(issueCounts[row.issue]||0)+1;});

    const monthlyCounts=MOS.map((_,index)=>countWhere(data,row=>parseInt(row.date.slice(5,7),10)-1===index));
    const topElevator=Object.entries(elevatorCounts).sort((a,b)=>b[1]-a[1])[0];
    const topElevatorLabel=topElevator&&topElevator[1]>0?`${formatElevatorLabel(topElevator[0])} (${topElevator[1]} incidents)`:'N/A';
    metricRows.push(['Elevator With Most Incidents',topElevatorLabel]);

    function drawCard(x,y,w,h,titleText){
      doc.setDrawColor(180,180,180);
      doc.setFillColor(255,255,255);
      doc.roundedRect(x,y,w,h,8,8,'FD');
      doc.setFontSize(11);
      doc.setTextColor(20,20,20);
      doc.text(titleText,x+12,y+18);
    }

    function drawBarChart(x,y,w,h,labels,values,color){
      const chartPad={left:30,right:10,top:18,bottom:28};
      const innerW=w-chartPad.left-chartPad.right;
      const innerH=h-chartPad.top-chartPad.bottom;
      const maxVal=Math.max(1,...values);
      const barW=Math.max(12,innerW/Math.max(1,labels.length)-10);

      doc.setDrawColor(200,200,200);
      doc.line(x+chartPad.left,y+chartPad.top,x+chartPad.left,y+chartPad.top+innerH);
      doc.line(x+chartPad.left,y+chartPad.top+innerH,x+chartPad.left+innerW,y+chartPad.top+innerH);

      labels.forEach((label,index)=>{
        const value=values[index]||0;
        const barH=(value/maxVal)*innerH;
        const barX=x+chartPad.left+index*(barW+8)+4;
        const barY=y+chartPad.top+innerH-barH;

        doc.setFillColor(color[0],color[1],color[2]);
        doc.rect(barX,barY,barW,barH,'F');
        doc.setFontSize(7);
        doc.setTextColor(60,60,60);
        doc.text(String(label),barX+barW/2,y+chartPad.top+innerH+12,{align:'center',angle:35});
      });
    }

    function drawPieChart(cx,cy,r,entries){
      const total=Math.max(1,entries.reduce((sum,entry)=>sum+entry.value,0));
      let angle=-Math.PI/2;

      entries.forEach((entry,index)=>{
        const slice=(entry.value/total)*Math.PI*2;
        const end=angle+slice;
        const color=entry.color;
        const points=[[cx,cy]];
        const segments=Math.max(6,Math.ceil(slice/(Math.PI/12)));

        for(let i=0;i<=segments;i++){
          const t=angle+(slice*i/segments);
          points.push([cx+Math.cos(t)*r,cy+Math.sin(t)*r]);
        }

        doc.setFillColor(color[0],color[1],color[2]);
        doc.setDrawColor(255,255,255);
        doc.lines(points.slice(1).map((point,pointIndex)=>{
          if(pointIndex===0)return [point[0]-cx,point[1]-cy];
          return [point[0]-points[pointIndex+1][0],point[1]-points[pointIndex+1][1]];
        }),cx,cy,[1,1],'F',true);

        angle=end;
      });

      doc.setFillColor(255,255,255);
      doc.circle(cx,cy,r*0.45,'F');

      let legendY=cy+r+12;
      entries.forEach(entry=>{
        doc.setFillColor(entry.color[0],entry.color[1],entry.color[2]);
        doc.rect(cx-r,legendY-6,8,8,'F');
        doc.setFontSize(8);
        doc.setTextColor(40,40,40);
        doc.text(`${entry.label} (${entry.value})`,cx-r+12,legendY+1);
        legendY+=12;
      });
    }

    function drawLineChart(x,y,w,h,labels,values,color){
      const chartPad={left:22,right:10,top:16,bottom:20};
      const innerW=w-chartPad.left-chartPad.right;
      const innerH=h-chartPad.top-chartPad.bottom;
      const maxVal=Math.max(1,...values);
      const stepX=labels.length>1?innerW/(labels.length-1):innerW;

      doc.setDrawColor(200,200,200);
      doc.line(x+chartPad.left,y+chartPad.top,x+chartPad.left,y+chartPad.top+innerH);
      doc.line(x+chartPad.left,y+chartPad.top+innerH,x+chartPad.left+innerW,y+chartPad.top+innerH);

      doc.setDrawColor(color[0],color[1],color[2]);
      for(let i=0;i<labels.length;i++){
        const px=x+chartPad.left+i*stepX;
        const py=y+chartPad.top+innerH-(values[i]/maxVal)*innerH;
        if(i>0){
          const prevX=x+chartPad.left+(i-1)*stepX;
          const prevY=y+chartPad.top+innerH-(values[i-1]/maxVal)*innerH;
          doc.line(prevX,prevY,px,py);
        }
        doc.setFillColor(color[0],color[1],color[2]);
        doc.circle(px,py,2.2,'F');
        doc.setFontSize(7);
        doc.setTextColor(70,70,70);
        doc.text(labels[i],px,y+chartPad.top+innerH+11,{align:'center'});
      }
    }

    doc.setFontSize(16);
    doc.setTextColor(20,20,20);
    doc.text(title,30,30);
    doc.setFontSize(9);
    doc.setTextColor(80,80,80);
    doc.text(generated,30,44);

    doc.autoTable({
      head:[['METRIC','VALUE']],
      body:metricRows,
      startY:56,
      margin:{left:30,right:0},
      tableWidth:320,
      styles:{fontSize:8,cellPadding:4,overflow:'linebreak'},
      headStyles:{fillColor:[31,41,55],textColor:[255,255,255]},
      columnStyles:{0:{cellWidth:220},1:{cellWidth:100}}
    });

    const activeElevators=Object.entries(elevatorCounts)
      .filter(([,count])=>count>0)
      .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
      .slice(0,10);
    const barLabels=(activeElevators.length?activeElevators:Object.entries(elevatorCounts).slice(0,8)).map(([elevator])=>formatElevatorLabel(elevator));
    const barValues=(activeElevators.length?activeElevators:Object.entries(elevatorCounts).slice(0,8)).map(([,count])=>count);

    const pieColors=[
      [59,130,246],[244,114,182],[34,197,94],[234,179,8],[99,102,241],[251,146,60],[107,114,128]
    ];
    const pieEntries=ISSUES
      .map((issue,index)=>({label:issue,value:issueCounts[issue]||0,color:pieColors[index%pieColors.length]}))
      .filter(entry=>entry.value>0);

    drawCard(365,56,430,230,'Incidents by Issue Type');
    if(pieEntries.length){
      drawPieChart(575,158,74,pieEntries);
    }else{
      doc.setFontSize(9);
      doc.setTextColor(110,110,110);
      doc.text('No issue data for selected year.',500,165);
    }

    drawCard(30,245,765,250,'Incidents by Elevator');
    drawBarChart(42,275,740,200,barLabels,barValues,[59,130,246]);

    drawCard(365,505,430,85,'Monthly Incident Trend');
    drawLineChart(377,526,405,50,MOS,monthlyCounts,[16,185,129]);

    doc.addPage('a4','landscape');
    doc.setFontSize(14);
    doc.setTextColor(20,20,20);
    doc.text(`Incident Log - ${yr}`,30,32);
    doc.setFontSize(9);
    doc.setTextColor(80,80,80);
    doc.text(generated,30,46);

    const head=[['ID','Date','Building','Elevator','Issue Type','Description','Status','Resolution Notes']];
    const body=data.map(row=>[
      row.id,
      row.date,
      row.building||'',
      formatElevatorLabel(row.elevator),
      row.issue||'',
      row.description||'',
      row.status||'',
      row.notes||''
    ]);

    doc.autoTable({
      head,
      body:body.length?body:[['','','','','','No incidents for selected year.','','']],
      startY:56,
      margin:{left:24,right:24},
      styles:{fontSize:8,cellPadding:4,overflow:'linebreak',valign:'top'},
      headStyles:{fillColor:[55,65,81],textColor:[255,255,255]},
      columnStyles:{
        0:{cellWidth:28},
        1:{cellWidth:56},
        2:{cellWidth:92},
        3:{cellWidth:62},
        4:{cellWidth:80},
        5:{cellWidth:180},
        6:{cellWidth:60},
        7:{cellWidth:170}
      }
    });

    doc.addPage('a4','landscape');
    doc.setFontSize(14);
    doc.setTextColor(20,20,20);
    doc.text(`Entrapment Log - ${yr}`,30,32);
    doc.setFontSize(9);
    doc.setTextColor(80,80,80);
    doc.text(generated,30,46);

    const trapBody=entrapments.map(row=>[
      row.id,
      row.date,
      row.building||'',
      formatElevatorLabel(row.elevator),
      row.issue||'',
      row.description||'',
      row.status||'',
      row.notes||''
    ]);

    doc.autoTable({
      head,
      body:trapBody.length?trapBody:[['','','','','','No entrapments for selected year.','','']],
      startY:56,
      margin:{left:24,right:24},
      styles:{fontSize:8,cellPadding:4,overflow:'linebreak',valign:'top'},
      headStyles:{fillColor:[185,28,28],textColor:[255,255,255]},
      columnStyles:{
        0:{cellWidth:28},
        1:{cellWidth:56},
        2:{cellWidth:92},
        3:{cellWidth:62},
        4:{cellWidth:80},
        5:{cellWidth:180},
        6:{cellWidth:60},
        7:{cellWidth:170}
      }
    });

    doc.save(`LiftLog_${yr}_Report.pdf`);
    status.className='xl-status done';
    status.textContent=`LiftLog_${yr}_Report.pdf downloaded (dashboard + log pages).`;
  }catch(error){
    status.className='xl-status fail';
    status.textContent='PDF export failed: '+error.message;
  }finally{
    btn.disabled=false;
  }
}

//  Save Incident 
function saveInc(){
  const date=$('f-date').value;
  const bld=$('f-bld').value.trim();
  const elev=String($('f-elev').value).replace('Elevator ','').trim();
  const issue=$('f-issue').value;
  const stat=$('f-stat').value;
  const desc=$('f-desc').value.trim();
  const notes=$('f-notes').value.trim();
  if(!date||!bld){
    showAddToast('err','Please fill in Date and Building.');
    return;
  }
  const data=load();
  const id=data.length?Math.max(...data.map(r=>r.id))+1:1;
  data.push({id,date,building:bld,elevator:elev,issue,description:desc,status:stat,notes,created:new Date().toISOString()});
  save(data);
  showAddToast('ok',`Saved: ${formatElevatorLabel(elev)} - ${issue} on ${date}`);
  clearIncidentForm();
  initYrDrop();refresh();
}

//  Init filters 
function initFilters(){
  setHtml('f-elev',ELEVS.map(l=>`<option>${formatElevatorLabel(l)}</option>`).join(''));
  setHtml('f-issue',ISSUES.map(t=>`<option>${t}</option>`).join(''));
  const yrs=buildYearList();
  setHtml('lf-yr','<option value="">All Years</option>'+yrs.map(y=>`<option value="${y}">${y}</option>`).join(''));
  setHtml('lf-mo','<option value="">All Months</option>'+MOSL.map((m,i)=>`<option value="${i+1}">${m}</option>`).join(''));
  setHtml('lf-el','<option value="">All Elevators</option>'+ELEVS.map(l=>`<option value="${l}">${formatElevatorLabel(l)}</option>`).join(''));
  setHtml('lf-is','<option value="">All Issue Types</option>'+ISSUES.map(t=>`<option>${t}</option>`).join(''));
  setHtml('lf-st','<option value="">All Statuses</option>'+STATS.map(s=>`<option>${s}</option>`).join(''));
  $('f-date').value=new Date().toISOString().slice(0,10);
}

function initPdfImport(){
  const input=$('pdf-upload');
  const clearBtn=$('clear-btn');
  if(input){
    input.addEventListener('change',async event=>{
      const file=event.target.files?.[0];
      await processPdfFile(file);
      event.target.value='';
    });
  }
  if(clearBtn)clearBtn.addEventListener('click',clearIncidentForm);
}

//  Boot 
if(!localStorage.getItem(STORAGE_RESET_KEY)){
  localStorage.removeItem(STORAGE_KEY);
  localStorage.setItem(STORAGE_RESET_KEY,'1');
}
initYrDrop();
initFilters();
initPdfImport();
renderDash();
renderLog();
renderTrap();
renderDL();
