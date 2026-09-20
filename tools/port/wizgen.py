import io,re,json

SRC='_old/13_Web/static/cloud-decision-logic-kit/multi-cloud-decision-matrix.html'
s=io.open(SRC,encoding='utf-8',errors='replace').read()
html=s[:s.find('<script')]

def tag_end(src,start):
    tag=re.match(r'<(\w+)',src[start:]).group(1)
    depth=0;k=start;pat=re.compile(r'</?%s\b'%tag)
    while True:
        m=pat.search(src,k)
        if not m: return len(src)
        if src[m.start():m.start()+2]=='</':
            depth-=1
            if depth==0: return m.end()+1
        else: depth+=1
        k=m.end()

def clean(t):
    t=re.sub(r'<[^>]+>','',t)
    for a,b in [('&amp;','&'),('&lt;','<'),('&gt;','>'),('&ndash;','–'),('&nbsp;',' '),('&quot;','"'),('&#39;',"'")]:
        t=t.replace(a,b)
    return re.sub(r'\s+',' ',t).strip()

def parse_field(block):
    lab=re.search(r'<label[^>]*>(.*?)</label>',block,re.S)
    raw=lab.group(1) if lab else ''
    required='*' in clean(raw)
    label=clean(raw).rstrip('*').strip()
    hm=re.search(r'<div class="hint">(.*?)</div>',block,re.S)
    hint=clean(hm.group(1)) if hm else ''

    cb=re.findall(r'<label[^>]*>\s*<input type="checkbox" name="([^"]+)" value="([^"]+)"\s*/?>\s*([^<]*)</label>',block,re.S)
    if cb:
        return {'kind':'field','id':cb[0][0],'control':'checkboxes','label':label,'hint':hint,
                'required':required,'options':[{'value':v,'label':clean(t)} for _,v,t in cb]}

    sel=re.search(r'<select([^>]*)id="([^"]+)"([^>]*)>(.*?)</select>',block,re.S)
    if sel:
        attrs=sel.group(1)+sel.group(3)
        opts=[{'value':m.group(1),'label':clean(m.group(2))}
              for m in re.finditer(r'<option[^>]*value="([^"]*)"[^>]*>(.*?)</option>',sel.group(4),re.S)
              if m.group(1)!='']
        return {'kind':'field','id':sel.group(2),
                'control':'multiselect' if 'multiple' in attrs else 'select',
                'label':label,'hint':hint,'required':required,'options':opts}

    ta=re.search(r'<textarea[^>]*id="([^"]+)"([^>]*)>',block)
    if ta:
        ph=re.search(r'placeholder="([^"]*)"',ta.group(0))
        return {'kind':'field','id':ta.group(1),'control':'textarea','label':label,'hint':hint,
                'required':required,'options':[],'placeholder':clean(ph.group(1)) if ph else ''}

    inp=re.search(r'<input[^>]*id="([^"]+)"[^>]*>',block)
    if inp:
        typ=re.search(r'type="(\w+)"',inp.group(0))
        ph=re.search(r'placeholder="([^"]*)"',inp.group(0))
        return {'kind':'field','id':inp.group(1),
                'control':'number' if (typ and typ.group(1)=='number') else 'text',
                'label':label,'hint':hint,'required':required,'options':[],
                'placeholder':clean(ph.group(1)) if ph else ''}
    return None

def items_in(block):
    """Fields and sub-headings, in the order they appear — which is what puts
    each one in the right grid cell."""
    marks=[]
    for m in re.finditer(r'<div class="field"',block): marks.append((m.start(),'field'))
    for m in re.finditer(r'<div class="field-group-title">(.*?)</div>',block,re.S):
        marks.append((m.start(),('heading',clean(m.group(1)))))
    marks.sort()
    out=[]
    for pos,what in marks:
        if what=='field':
            f=parse_field(block[pos:tag_end(block,pos)])
            if f: out.append(f)
        else:
            out.append({'kind':'heading','text':what[1]})
    return out

HEADERS={
 1:("Step 1 · Initiative & basics",
    "New vs existing vs maintenance vs migration, plus workload basics",
    "Pick initiative type and capture basics."),
 2:("Step 2 · Path details & data",
    "Details for the chosen initiative type plus data, sector and integration pattern",
    "Refine the path type and describe data, sector and integrations."),
 3:("Step 3 · Non-functional, security & migration tooling",
    "Criticality, SLOs, security baseline, source environment, 7R approach and automation tools",
    "How critical it is and how you will move & run it."),
 4:("Step 4 · Sizing & environments",
    "Traffic band, data volume, environments in scope and regions for this workload",
    "Capture sizing bands and environments before generating the playbook."),
}
PATHS={'path-new-service':'new-service','path-existing-change':'existing-service',
       'path-maintenance':'maintenance','path-migration':'migration'}

steps=[]
for n in (1,2,3,4):
    i=html.find('<div id="step-%d"'%n)
    block=html[i:tag_end(html,i)]
    groups=[]; stripped=block
    for gm in list(re.finditer(r'<div class="path-group path-grid" id="(path-[\w-]+)"',block))[::-1]:
        gb=block[gm.start():tag_end(block,gm.start())]
        groups.insert(0,{'id':gm.group(1),'showFor':PATHS[gm.group(1)],'items':items_in(gb)})
        stripped=stripped[:gm.start()]+stripped[gm.start()+len(gb):]
    t,sub,hint=HEADERS[n]
    steps.append({'number':n,'title':t,'subtitle':sub,'hint':hint,
                  'items':items_in(stripped),'groups':groups})

def esc(x): return x.replace('\\','\\\\').replace("'","\\'")

def item_ts(it,ind):
    if it['kind']=='heading':
        return "%s{ kind: 'heading', text: '%s' }," % (ind, esc(it['text']))
    L=[ind+'{']
    L.append(ind+"  kind: 'field',")
    L.append(ind+"  id: '%s'," % it['id'])
    L.append(ind+"  label: '%s'," % esc(it['label']))
    L.append(ind+"  control: '%s'," % it['control'])
    if it.get('hint'): L.append(ind+"  hint: '%s'," % esc(it['hint']))
    if it.get('placeholder'): L.append(ind+"  placeholder: '%s'," % esc(it['placeholder']))
    if it.get('required'): L.append(ind+'  required: true,')
    if it.get('options'):
        L.append(ind+'  options: [')
        for o in it['options']:
            L.append(ind+"    { value: '%s', label: '%s' }," % (esc(o['value']), esc(o['label'])))
        L.append(ind+'  ],')
    L.append(ind+'},')
    return '\n'.join(L)

out=["""/**
 * The wizard's questions.
 *
 * Ported from the previous toolkit's multi-cloud-decision-matrix.html: the same
 * four steps, the same questions, the same answer sets, the same hints, and —
 * this matters more than it sounds — the same order.
 *
 * The order matters because the questions are laid out two to a row. A section
 * heading occupies a cell of its own, so dropping one shifts every question
 * after it into the wrong column. Headings are therefore items in this list
 * rather than decoration applied afterwards.
 *
 * The ids matter too. The recommendation engine in ./engine.js reads every
 * answer out of the DOM by element id, so these are the contract between the
 * two files: rename one here and the engine silently stops seeing that answer.
 *
 * Step 2 has four alternative groups of questions, one per initiative type.
 * Only the matching group is asked, which is what `showFor` selects.
 */

export type WizardControl =
  | 'select'
  /** A select that takes several answers; the engine reads it with getMultiSelectValues. */
  | 'multiselect'
  /** Checkboxes sharing one name; the engine reads them with getCheckedValues. */
  | 'checkboxes'
  | 'text'
  | 'number'
  | 'textarea';

export interface WizardOption {
  readonly value: string;
  readonly label: string;
}

export interface WizardField {
  readonly kind: 'field';
  /** Element id, or the shared name for a checkbox group. */
  readonly id: string;
  readonly label: string;
  readonly control: WizardControl;
  readonly hint?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly options?: readonly WizardOption[];
}

/** A sub-heading inside a step. It takes a grid cell, which is why it is here. */
export interface WizardHeading {
  readonly kind: 'heading';
  readonly text: string;
}

export type WizardItem = WizardField | WizardHeading;

export interface WizardGroup {
  readonly id: string;
  /** Initiative type this group belongs to. */
  readonly showFor: string;
  readonly items: readonly WizardItem[];
}

export interface WizardStep {
  readonly number: number;
  readonly title: string;
  readonly subtitle: string;
  /** The line under the form saying what this step is for. */
  readonly hint: string;
  readonly items: readonly WizardItem[];
  readonly groups?: readonly WizardGroup[];
}

export const WIZARD_STEPS: readonly WizardStep[] = ["""]

for st in steps:
    out.append('  {')
    out.append('    number: %d,' % st['number'])
    out.append("    title: '%s'," % esc(st['title']))
    out.append("    subtitle: '%s'," % esc(st['subtitle']))
    out.append("    hint: '%s'," % esc(st['hint']))
    out.append('    items: [')
    for it in st['items']: out.append(item_ts(it,'      '))
    out.append('    ],')
    if st['groups']:
        out.append('    groups: [')
        for g in st['groups']:
            out.append('      {')
            out.append("        id: '%s'," % g['id'])
            out.append("        showFor: '%s'," % g['showFor'])
            out.append('        items: [')
            for it in g['items']: out.append(item_ts(it,'          '))
            out.append('        ],')
            out.append('      },')
        out.append('    ],')
    out.append('  },')
out.append('];')
out.append('')
out.append("""/** The clouds the wizard can design for. */
export const WIZARD_CLOUDS: readonly WizardOption[] = [
  { value: 'azure', label: 'Microsoft Azure' },
  { value: 'aws', label: 'Amazon Web Services (AWS)' },
  { value: 'gcp', label: 'Google Cloud Platform (GCP)' },
  { value: 'oci', label: 'Oracle Cloud Infrastructure (OCI)' },
];

/** Cloud id as the rest of the toolkit spells it, for the shared selection. */
export const WIZARD_CLOUD_TO_TARGET: Readonly<Record<string, string>> = {
  azure: 'azure',
  aws: 'aws',
  gcp: 'google',
  oci: 'oci',
};

export function isField(item: WizardItem): item is WizardField {
  return item.kind === 'field';
}

/** Every question in the wizard, in order. */
export function allFields(): readonly WizardField[] {
  const out: WizardField[] = [];
  for (const step of WIZARD_STEPS) {
    out.push(...step.items.filter(isField));
    for (const group of step.groups ?? []) out.push(...group.items.filter(isField));
  }
  return out;
}
""")
io.open('src/multicloud/wizard/steps.ts','w',encoding='utf-8',newline='\n').write('\n'.join(out))

tot=0
for st in steps:
    f=sum(1 for i in st['items'] if i['kind']=='field')+sum(1 for g in st['groups'] for i in g['items'] if i['kind']=='field')
    h=sum(1 for i in st['items'] if i['kind']=='heading')
    tot+=f
    print('Step %d: %d questions, %d sub-headings, %d groups' % (st['number'],f,h,len(st['groups'])))
print('TOTAL questions:', tot)
