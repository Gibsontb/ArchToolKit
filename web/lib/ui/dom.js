/**
 * Minimal DOM helpers.
 *
 * There is no framework here, so this provides the two things a framework
 * mainly buys you: terse element construction, and safe text interpolation.
 * Everything goes through textContent rather than innerHTML, so imported
 * inventory data can never inject markup.
 */

                                                                      

                                 
                          
                       
                                  
                        
                                                                                
                                            
                                                                                   
                                                
 

export function el                                       (
  tag   ,
  options                 = {},
  ...children         
)                           {
  const node = document.createElement(tag);

  if (options.class) node.className = options.class;
  if (options.id) node.id = options.id;
  if (options.text !== undefined) node.textContent = String(options.text);

  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) {
      node.dataset[key] = value;
    }
  }

  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      if (handler) node.addEventListener(event, handler                 );
    }
  }

  if (options.style) Object.assign(node.style, options.style);

  append(node, ...children);
  return node;
}

export function append(parent      , ...children         )       {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node      )       {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node      , ...children         )       {
  clear(node);
  append(node, ...children);
}

/** Query a required element, throwing a useful error when the markup drifts. */
export function must                                 (selector        , root             = document)    {
  const found = root.querySelector   (selector);
  if (!found) throw new Error(`Required element not found: ${selector}`);
  return found;
}

export function maybe                                 (
  selector        ,
  root             = document,
)           {
  return root.querySelector   (selector);
}

export function allOf                                 (
  selector        ,
  root             = document,
)      {
  return Array.from(root.querySelectorAll   (selector));
}

/** Trigger a client-side file download without a server round trip. */
export function downloadFile(filename        , contents        , mime = 'application/json')       {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { attrs: { href: url, download: filename } });
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on the next tick; revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read a user-selected file as text. */
export function readFileAsText(file      )                  {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsText(file);
  });
}
