/**
 * A Splunk app, as the files someone can deploy.
 *
 * The conf files, an `app.conf` so it is a real app, a `metadata/default.meta`
 * so the objects in it are visible to anyone, and a deployment note saying
 * which tier it goes on and how it is activated.
 *
 * All of it from one structure, so the note cannot describe a different app
 * from the one in the directory.
 */

                                                                                   
                                                   
import { appConf, renderApp, renderRecord, standingFindings,                                 } from './splunk.js';

                                                    
                                                                       
                            
                                                             
                                                                     
 

export function appFiles(app           , name        )              {
  const findings            = [...(app.findings ?? []), ...standingFindings(app)];
  const files                         = renderApp(app, name);

  // An app without an app.conf is a directory Splunk may or may not read.
  if (!Object.keys(app.files).some((path) => path.endsWith('app.conf'))) {
    files[`${app.app}/default/app.conf`] = `${appConf(app, app.title).join('\n')}\n`;
  }

  files['DEPLOY.md'] = `${[`# ${app.title}`, '', ...renderRecord(app, name)].join('\n')}\n`;

  return { files, findings };
}

/**
 * Declare a blueprint from an app builder.
 *
 * The page sees an ordinary `Blueprint`; anything that needs the structure —
 * the deployment note, the tier grouping — sees the app underneath it.
 */
export function splunkBlueprint(
  spec                                        
                              
                                       
                                                                       
   ,
)                  {
  return {
    ...spec,
    emits: spec.emits ?? [],
    build: (values                 , name        ) => appFiles(spec.app(values, name), name),
  };
}
