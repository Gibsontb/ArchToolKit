/**
 * ArchPad's shared contract.
 *
 * ArchPad is one editor with two homes: a page in ArchToolKit (the browser)
 * and ArchPad.exe (a WebView2 window on Windows). Everything that differs
 * between them — opening and saving files, the window title, closing — goes
 * through a Host. The editor core, the tools and the page are written once
 * against these types.
 */

                                       
                                                                                        

/** A file as it comes off disk: the raw bytes are decoded by the core, not the host. */
                             
                        
                                                                                              
                         
                             
                                                                                                          
                            
                                 
 

                              
                        
                         
                            
                             
 

                             
                        
                         
                            
 

/**
 * Where ArchPad runs. Browser: File System Access API with download/upload
 * fallbacks. Exe: messages to the C# host over window.chrome.webview.
 */
                       
                                   
                                                                                    
                                     
                                                                                                              
                                                         
                                                 
                                                           
                                                                                                  
                                                                                                 
                                                                                                         
                                                                                                   
                                                        
                                
                                                                                                     
                                                                 
                                                                                                                          
                                                              
 

/** A menu item. Tools, line operations and plugins all register as commands. */
                          
                      
                         
                                    
                                                                                                                                   
                                                                                     
                          
                                                                                    
                             
                                                              
 

/** What a command can see and change: the active document's text and selection, and a way to report. */
                                 
                                               
                    
                                                           
                         
                                                                                                     
                                                                                        
                                    
                              
                                          
                                                                   
                                                           
                                                         
                                                                               
                                                                  
                                                                   
                                                             
 

/** What the page or the exe gets back from mounting ArchPad (src/archpad/app.ts exports `mountArchPad`). */
                             
                                                                         
                                           
                                  
                                                                   
                                               
                        
 

                               
                                                       
                                         
                                                                                                  
                                   
 
