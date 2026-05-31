const assert=require('assert');
const {parseLocal,mergeWithLocal}=require('../server');

function assertNoEmpty(incident,label){
  const keys=['date','building','location','elevator','issue','status','description','notes','reference'];
  keys.forEach(key=>{
    assert.ok(String(incident[key]||'').trim(),`${label}: expected non-empty ${key}`);
  });
}

function testIncidentReport(){
  const text=`
Incident Report
Date: 03/23/2026
Client: One Buckhead Plaza
LOCATION OF THE PROBLEM: 3060 Peachtree RD NW / 19th Floor
Service Elevator Cab #10 was stuck near the 19th floor with Eric Benitez inside.
KONE service ticket #17542681 was created. Occupant was released safely.
Action(s) Taken: Security assisted and elevator was placed out of service.
`;

  const incident=parseLocal(text);
  assert.strictEqual(incident.date,'2026-03-23');
  assert.strictEqual(incident.building,'One Buckhead Plaza');
  assert.strictEqual(incident.location,'3060 Peachtree RD NW / 19th Floor');
  assert.strictEqual(incident.elevator,'Elevator 10');
  assert.strictEqual(incident.issue,'Entrapment');
  assert.ok(incident.description.includes('#17542681'));
  assertNoEmpty(incident,'incident_report');
}

function testFillableIncidentReport(){
  const text=`
Incident Report
[FORM FIELD] Date: 03/23/2026
[FORM FIELD] Client: Cousins Properties
[FORM FIELD] Location: Service Elevator Cab #10
[FORM FIELD] Persons Involved NameDescriptionRow1: Eric Benitez
[FORM FIELD] Description of Incident Explain in detail who what when and where Use other side if neededRow1: On March 23, 2026, Zacharias Martin called a Code Gold for elevator entrapment once it was discovered that Eric Benitez was stuck inside Service Elevator at One Buckhead Plaza on the 19th floor.
[FORM FIELD] Action Taken Was incident resolvedRow1: A service request was created with KONE under reference number #17542681. ADOS Dunlap and Rover Officer Martin communicated with the entrapped until he was released.
`;

  const incident=parseLocal(text);
  assert.strictEqual(incident.date,'2026-03-23');
  assert.strictEqual(incident.building,'One Buckhead Plaza');
  assert.strictEqual(incident.elevator,'Elevator 10');
  assert.strictEqual(incident.issue,'Entrapment');
  assert.ok(incident.description.includes('Eric Benitez'));
  assert.ok(incident.description.includes('#17542681'));
  assert.ok(incident.notes.includes('#17542681'));
  assertNoEmpty(incident,'fillable_incident_report');
}

function testCallLog(){
  const text=`
ELEVATOR CALL LOG
DATE: 05/14/2026
LOCATION OF THE PROBLEM: 3060 Peachtree RD NW / 16th Floor
CAB #: G
DESCRIPTION OF THE PROBLEM:
On May 14, 2026, Elevator G was out of service on the 16th floor. No entrapment occurred.
KONE was contacted and service ticket reference #17466105 was created.
FULL NAME OF THE ELEVATOR TECHNICIAN: John Smith
ACTUAL TIME OF ARRIVAL: 13:24
Technician notes: Had to adjust the brake switch for elevator G.
`;

  const incident=parseLocal(text);
  assert.strictEqual(incident.date,'2026-05-14');
  assert.strictEqual(incident.building,'3060 Peachtree RD NW / 16th Floor');
  assert.strictEqual(incident.elevator,'Elevator G');
  assert.strictEqual(incident.issue,'Mechanical Failure');
  assert.strictEqual(incident.status,'Resolved');
  assert.ok(incident.description.includes('#17466105'));
  assertNoEmpty(incident,'call_log');
}

function testFillableCallLog(){
  const text=`
ELEVATOR CALL LOG
LOCATION OF THE PROBLEM: _______________________ CAB #: _______________________________
[FORM FIELD] CALLED IN BY: Danielle Pabon
[FORM FIELD] DATE: 05/14/2026
[FORM FIELD] TIME: 9:33 AM
[FORM FIELD] LOCATION OF THE PROBLEM: 3060 Peachtree RD NW
[FORM FIELD] CAB: G
[FORM FIELD] DESCRIPTION OF THE PROBLEM: On Thursday, May 14, 2026, Deputy Assistant Director of Security Darrius Oliver observed that Elevator G was out of service on the 16th floor. No entrapments were reported. Security Rover Pabon contacted KONE Elevator Service regarding the issue and spoke with representative Chris, who generated service ticket reference #17466105 for repair dispatch.
[FORM FIELD] ACTUAL TIME OF ARRIVAL: 6:43 am
[FORM FIELD] DESCRIPTION OF THE PROBLEM_2: Had to adjust the break switch for elevator (G)
[FORM FIELD] FULL NAME OF THE ELEVATOR TECHNICIAN: Eric Werlinger
`;

  const incident=parseLocal(text);
  assert.strictEqual(incident.date,'2026-05-14');
  assert.strictEqual(incident.building,'3060 Peachtree RD NW');
  assert.strictEqual(incident.elevator,'Elevator G');
  assert.strictEqual(incident.issue,'Mechanical Failure');
  assert.strictEqual(incident.status,'Resolved');
  assert.ok(incident.description.includes('#17466105'));
  assert.ok(incident.notes.includes('Eric Werlinger'));
  assertNoEmpty(incident,'fillable_call_log');
}

function testAiMergeRules(){
  const text=`
ELEVATOR CALL LOG
DATE: 05/14/2026
LOCATION OF THE PROBLEM: 3060 Peachtree RD NW / 16th Floor
CAB #: G
DESCRIPTION OF THE PROBLEM: Elevator was out of service. service ticket #17466105.
`;
  const ai={
    date:'2026-05-14',
    building:'wrong value',
    elevator:'Elevator Q',
    issue_type:'Other',
    status:'Open',
    description:'AI summary sample.',
    resolution_notes:'AI notes.'
  };

  const merged=mergeWithLocal(ai,text);
  assert.strictEqual(merged.building,'3060 Peachtree RD NW / 16th Floor');
  assert.strictEqual(merged.elevator,'Elevator G');
  assert.ok(merged.description.includes('AI summary sample.'));
  assertNoEmpty(merged,'ai_merge');
}

function testAiDoesNotOverrideFillableFields(){
  const text=`
Incident Report
[FORM FIELD] Date: 03/23/2026
[FORM FIELD] Client: Cousins Properties
[FORM FIELD] Location: Service Elevator Cab #10
[FORM FIELD] Persons Involved NameDescriptionRow1: Eric Benitez
[FORM FIELD] Description of Incident Explain in detail who what when and where Use other side if neededRow1: On March 23, 2026, Eric Benitez was stuck inside Service Elevator at One Buckhead Plaza on the 19th floor.
[FORM FIELD] Action Taken Was incident resolvedRow1: A service request was created with KONE under reference number #17542681.
`;
  const ai={
    date:'2022-02-22',
    building:'Client',
    elevator:'Elevator A',
    issue_type:'Entrapment',
    status:'Open',
    description:'Wrong AI summary.',
    resolution_notes:'Wrong AI notes.'
  };

  const merged=mergeWithLocal(ai,text);
  assert.strictEqual(merged.date,'2026-03-23');
  assert.strictEqual(merged.building,'One Buckhead Plaza');
  assert.strictEqual(merged.elevator,'Elevator 10');
  assert.ok(merged.description.includes('Eric Benitez'));
  assert.ok(merged.notes.includes('#17542681'));
  assertNoEmpty(merged,'ai_fillable_guardrails');
}

function run(){
  testIncidentReport();
  testFillableIncidentReport();
  testCallLog();
  testFillableCallLog();
  testAiMergeRules();
  testAiDoesNotOverrideFillableFields();
  console.log('All import pipeline tests passed.');
}

run();
