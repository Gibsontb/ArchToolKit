                                                                     

const ps=(value        )=>"'"+String(value??'').replace(/'/g,"''")+"'";
const number=(value        ,min       )=>{const out=Number(value);if(!Number.isFinite(out)||out<min||!Number.isInteger(out))throw Error('Enter a whole number of at least '+min);return out;};
function service(id       ,label       ,inputs                          ,script                                        )           {
  return {id,label,description:label+' on an existing Hyper-V host.',inputs,emits:['ansible.windows.win_powershell'],build:values=>{
    const code="$ErrorActionPreference = 'Stop'\nImport-Module Hyper-V -ErrorAction Stop\n"+script(values);
    return {files:{
      'service.yml':JSON.stringify([{name:label,hosts:'hyperv',gather_facts:false,tasks:[{name:label,'ansible.windows.win_powershell':{script:code}}]}],null,2),
      'requirements.yml':'collections:\n  - name: ansible.windows\n',
      'inventory.example.ini':'[hyperv]\nhyperv-host.example.invalid\n\n[hyperv:vars]\nansible_connection=winrm\nansible_winrm_transport=kerberos\n',
      'README.md':'# '+label+'\n\nReview the generated settings. Configure WinRM and authentication for the existing host in your inventory. Install ansible.windows from requirements.yml, then run ansible-playbook -i inventory.ini service.yml. New VMs are left stopped; install or attach the guest OS before starting them.\n\nReference: https://learn.microsoft.com/en-us/powershell/module/hyper-v/\n',
    },findings:[]};
  }};
}
export const HYPERV_SERVICES                     =[
  service('hyperv_add_vm','Add a Hyper-V virtual machine',[
    {id:'vm_name',label:'VM name',control:'text'}, {id:'switch',label:'Existing virtual switch',control:'text'},
    {id:'memory',label:'Memory (GiB)',control:'number',min:1,default:4}, {id:'cpus',label:'Virtual processors',control:'number',min:1,default:2},
    {id:'generation',label:'Generation',control:'select',options:[{value:'2',label:'Generation 2'},{value:'1',label:'Generation 1'}],default:'2'},
  ],v=>{
    if(!String(v.vm_name??'').trim()||!String(v.switch??'').trim())throw Error('Enter a VM name and existing virtual switch.');
    return `if (Get-VM -Name ${ps(v.vm_name)} -ErrorAction SilentlyContinue) { throw 'VM already exists' }\nNew-VM -Name ${ps(v.vm_name)} -Generation ${number(v.generation,1)} -MemoryStartupBytes (${number(v.memory,1)} * 1GB) -SwitchName ${ps(v.switch)} -NoVHD\nSet-VMProcessor -VMName ${ps(v.vm_name)} -Count ${number(v.cpus,1)}\n`;
  }),
  service('hyperv_add_disk','Add a Hyper-V virtual disk',[
    {id:'path',label:'New VHDX path',control:'text'}, {id:'size',label:'Size (GiB)',control:'number',min:1,default:64},
  ],v=>{if(!String(v.path??'').toLowerCase().endsWith('.vhdx'))throw Error('Enter a new .vhdx path.');return `if (Test-Path -LiteralPath ${ps(v.path)}) { throw 'Disk already exists' }\nNew-VHD -Path ${ps(v.path)} -Dynamic -SizeBytes (${number(v.size,1)} * 1GB)\n`;}),
  service('hyperv_add_switch','Add a Hyper-V virtual switch',[
    {id:'name',label:'Switch name',control:'text'}, {id:'type',label:'Switch type',control:'select',options:[{value:'Internal',label:'Internal'},{value:'Private',label:'Private'}],default:'Internal'},
  ],v=>{if(!String(v.name??'').trim()||!['Internal','Private'].includes(String(v.type)))throw Error('Enter a switch name and select Internal or Private.');return `if (Get-VMSwitch -Name ${ps(v.name)} -ErrorAction SilentlyContinue) { throw 'Switch already exists' }\nNew-VMSwitch -Name ${ps(v.name)} -SwitchType ${ps(v.type)}\n`;}),
];
