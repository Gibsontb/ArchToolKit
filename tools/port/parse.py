import io,re,json

def brace_match(s,start):
    pairs={'{':'}','[':']','(':')'}
    o=s[start]; c=pairs[o]; d=0;k=start;instr=None;esc=False
    while k<len(s):
        ch=s[k]
        if esc: esc=False
        elif ch=='\\': esc=True
        elif instr:
            if ch==instr: instr=None
        elif ch in '"\'`': instr=ch
        elif ch==o: d+=1
        elif ch==c:
            d-=1
            if d==0: return k
        k+=1
    raise ValueError('unbalanced')

def scan(s):
    depth=0;k=0;instr=None;esc=False;keys=[]
    while k < len(s):
        c=s[k]
        if esc: esc=False; k+=1; continue
        if c=='\\': esc=True; k+=1; continue
        if instr:
            if c==instr: instr=None
            k+=1; continue
        if c in '"\'`': instr=c; k+=1; continue
        if c in '{[': depth+=1; k+=1; continue
        if c in '}]': depth-=1; k+=1; continue
        m=re.match(r'([A-Za-z_]\w*)\s*:\s*\{', s[k:])
        if m and (k==0 or s[k-1] in ' \n\t,{'):
            keys.append((depth, m.group(1), k+m.end()-1)); k+=m.end()-1; continue
        k+=1
    return keys

def arrow_source(rest):
    ab=rest.index('(')
    d=0;kk=ab;instr=None;esc=False
    while kk<len(rest):
        ch=rest[kk]
        if esc: esc=False
        elif ch=='\\': esc=True
        elif instr:
            if ch==instr: instr=None
        elif ch in '"\'`': instr=ch
        elif ch=='(': d+=1
        elif ch==')':
            d-=1
            if d==0: break
        kk+=1
    arrow=rest.index('=>', kk)
    seg=rest[arrow+2:arrow+60].lstrip()
    if seg.startswith('{'):
        nb=rest.index('{', arrow)
        return rest[ab:brace_match(rest,nb)+1]
    if seg.startswith('['):
        nb=rest.index('[', arrow)
        return rest[ab:brace_match(rest,nb)+1]
    if seg.startswith('('):
        nb=rest.index('(', arrow)
        return rest[ab:brace_match(rest,nb)+1]
    raise ValueError('unhandled arrow body: %r' % seg[:40])

def parse(src, buildkey):
    platforms={}
    for depth,key,pos in scan(src):
        if depth!=1: continue
        body=src[pos:brace_match(src,pos)+1]
        lab=re.search(r'label:\s*"([^"]+)"', body)
        si=body.find('scenarios:')
        if si<0: continue
        sb=body.index('{', si); sbody=body[sb:brace_match(body,sb)+1]
        scen={}
        for d2,k2,p2 in scan(sbody):
            if d2!=1: continue
            sb2=sbody[p2:brace_match(sbody,p2)+1]
            l=re.search(r'label:\s*"([^"]*)"', sb2)
            de=re.search(r'description:\s*"([^"]*)"', sb2)
            inp=None
            ii=sb2.find('inputs:')
            if ii>=0:
                ib=sb2.index('[', ii); inp=sb2[ib:brace_match(sb2,ib)+1]
            bld=None
            bi=sb2.find(buildkey+':')
            if bi>=0:
                try: bld=arrow_source(sb2[bi+len(buildkey)+1:])
                except Exception as e: bld=None
            scen[k2]={'label':l.group(1) if l else k2,'description':de.group(1) if de else '',
                      'inputs':inp,'build':bld}
        platforms[key]={'label':lab.group(1) if lab else key,'scenarios':scen}
    return platforms

tf=parse(io.open('/tmp/port/tf_defs.js',encoding='utf-8').read(),'buildTf')
an=parse(io.open('/tmp/port/an_defs.js',encoding='utf-8').read(),'buildPlay')
json.dump(tf, io.open('/tmp/port/tf.json','w',encoding='utf-8'))
json.dump(an, io.open('/tmp/port/an.json','w',encoding='utf-8'))
for nm,d in [('TERRAFORM',tf),('ANSIBLE',an)]:
    tot=0; print('==',nm)
    for p,v in d.items():
        ok=sum(1 for s in v['scenarios'].values() if s['inputs'] and s['build']); tot+=ok
        print('  %-8s %-42s %2d scenarios, %2d parsed' % (p, v['label'], len(v['scenarios']), ok))
    print('  TOTAL parsed:', tot)
