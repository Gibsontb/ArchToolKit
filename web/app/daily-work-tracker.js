const storageKey = 'archtoolkit.daily-work-tasks.v1';
const workType = document.getElementById('workType');
const subtype = document.getElementById('workSubtype');
const description = document.getElementById('taskDescription');
const expectedTime = document.getElementById('expectedTime');
const tableBody = document.getElementById('taskTableBody');
const status = document.getElementById('taskStatus');
const clearDone = document.getElementById('clearDoneBtn');
const clearAll = document.getElementById('clearAllBtn');
const subtypeOptions = {
  hardware: ['Install / upgrade', 'Troubleshooting', 'Inventory / asset', 'Cabling / rack', 'Other hardware'],
  software: ['Bug fix', 'Feature work', 'Patch / upgrade', 'Testing / QA', 'Other software'],
  admin: ['User access / IAM', 'Reporting', 'Documentation', 'Planning', 'Other admin'],
  iaas: ['VMs / instances', 'Storage', 'Networking', 'Security groups', 'Backup / DR'],
  paas: ['Databases', 'Functions / serverless', 'App services', 'Messaging / queues', 'Other PaaS'],
  saas: ['Account setup', 'Config / tuning', 'Integration', 'License management', 'Other SaaS'],
  network: ['Firewalls', 'Load balancers', 'VPN / routing', 'DNS / IPAM', 'Other networking'],
  security: ['Patching', 'Vuln review', 'Audit / compliance', 'Alerts / SIEM', 'Other security'],
  doc: ['Write docs', 'Update runbooks', 'Update diagrams', 'Review docs'],
  meeting: ['Standup', 'Planning', 'Review', 'One-on-one', 'Workshop'],
  other: ['General work', 'Follow-ups', 'Research / learning']
};

let tasks = [];
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
  if (!Array.isArray(saved)) throw new Error('Invalid task list');
  tasks = saved.filter(task => task && typeof task.description === 'string');
} catch {
  status.textContent = 'Saved tasks could not be loaded.';
}

function saveTasks() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(tasks));
    status.textContent = 'Tasks are stored in this browser.';
  } catch {
    status.textContent = 'Browser storage is unavailable. Changes are kept for this session.';
  }
}

function updateSubtypes() {
  subtype.replaceChildren(...subtypeOptions[workType.value].map(label => new Option(label, label)));
}

function updateTaskActions() {
  clearDone.disabled = !tasks.some(task => task.done);
  clearAll.disabled = tasks.length === 0;
}

function renderTasks() {
  tableBody.replaceChildren();
  if (!tasks.length) {
    const cell = tableBody.insertRow().insertCell();
    cell.colSpan = 5;
    cell.textContent = 'No tasks yet.';
  }
  for (const task of tasks) {
    const row = tableBody.insertRow();
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(task.done);
    checkbox.setAttribute('aria-label', 'Mark complete · ' + task.description);
    checkbox.addEventListener('change', () => {
      task.done = checkbox.checked;
      saveTasks();
      updateTaskActions();
    });
    row.insertCell().append(checkbox);
    for (const value of [[task.typeLabel, task.subtype].filter(Boolean).join(' · '),
      task.description, task.expectedTime || '—', task.createdAt]) {
      row.insertCell().textContent = value ?? '';
    }
  }
  updateTaskActions();
}

const clock = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const nowDisplay = document.getElementById('nowDisplay');
function updateClock() {
  nowDisplay.textContent = clock.format(new Date());
}
updateClock();
setInterval(updateClock, 60_000);

workType.addEventListener('change', updateSubtypes);
document.getElementById('taskForm').addEventListener('submit', event => {
  event.preventDefault();
  const task = description.value.trim();
  if (!task) {
    description.focus();
    return;
  }
  tasks.push({
    typeLabel: workType.selectedOptions[0].text,
    subtype: subtype.value,
    description: task,
    expectedTime: expectedTime.value,
    createdAt: clock.format(new Date()),
    done: false,
  });
  saveTasks();
  renderTasks();
  description.value = '';
  expectedTime.value = '';
  description.focus();
});

clearDone.addEventListener('click', () => {
  tasks = tasks.filter(task => !task.done);
  saveTasks();
  renderTasks();
});

clearAll.addEventListener('click', () => {
  if (!window.confirm('Clear all tasks?')) return;
  tasks = [];
  saveTasks();
  renderTasks();
});

updateSubtypes();
renderTasks();
