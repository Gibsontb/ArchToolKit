/**
 * Broadcom's four VCF Management Network Models.
 *
 * Where the fleet-level components live — VCF Operations, VCF Automation, the
 * Identity Broker, the License Server and VCF management services — is a named
 * design decision, not an incidental consequence of which networks happen to be
 * planned. The design library documents four models, and a spec silently lands
 * in one of them whether or not anyone chose it.
 *
 * Modelling them explicitly means the builder can say which model a document
 * represents, and can refuse to emit one that is internally inconsistent — a
 * dedicated model with no dedicated network, say.
 *
 * One rule cuts across all four: the cloud proxy (VCF Operations Collector) is a
 * VCF *Instance*-level component, not a fleet-level one, and the installer always
 * places it on the VM management network. No model moves it.
 *
 * Verification: V-DOC.
 * Source: VCF 9.1 Design Library — VCF Management Network Detailed Design
 * (retrieved 2026-09-20).
 */

                                    
                 
                    
                            
                                       

                                             
                                         
                                           
                         
                           
     
                                                                             
                                  
     
                                             
     
                                                                                
                                                       
     
                                           
                                                                                      
                              
 

export const MANAGEMENT_NETWORK_MODELS                                        = [
  {
    model: 'shared-vlan',
    label: 'VCF Management Shared VLAN Network Model',
    summary:
      'Fleet-level components share the distributed port group already used by the VCF Instance-level components — vCenter, NSX Manager and SDDC Manager.',
    requiresDedicatedNetwork: false,
    requiresOverlaySegment: false,
    stretched: false,
  },
  {
    model: 'dedicated-vlan',
    label: 'VCF Management Dedicated VLAN Network Model',
    summary:
      'Fleet-level components get a distributed port group of their own, used for nothing else.',
    requiresDedicatedNetwork: true,
    requiresOverlaySegment: false,
    stretched: false,
  },
  {
    model: 'dedicated-vlan-overlay',
    label: 'VCF Management Dedicated VLAN and NSX Overlay Segment Network Model',
    summary:
      'Two networks: VCF management services on a dedicated VLAN at bring-up, and the remaining fleet-level components on an NSX overlay segment.',
    requiresDedicatedNetwork: true,
    requiresOverlaySegment: true,
    stretched: false,
  },
  {
    model: 'dedicated-vlan-stretched-overlay',
    label: 'VCF Management Dedicated VLAN and NSX Stretched Overlay Segment Network Model',
    summary:
      'As the overlay model, but the segment is stretched between two regions to provide fleet disaster recovery.',
    requiresDedicatedNetwork: true,
    requiresOverlaySegment: true,
    stretched: true,
  },
];

export function managementNetworkModel(
  model                        ,
)                             {
  const rule = MANAGEMENT_NETWORK_MODELS.find((r) => r.model === model);
  if (!rule) throw new Error(`Unknown management network model: ${model}`);
  return rule;
}

/**
 * The cloud proxy stays on the VM management network in every model.
 *
 * It is a VCF Instance-level component rather than a fleet-level one, and the
 * installer places it there regardless of where the fleet-level components go.
 */
export const CLOUD_PROXY_ALWAYS_VM_MANAGEMENT =
  'The cloud proxy (VCF Operations Collector) is a VCF Instance-level component and is always deployed to the VM management network by VCF Installer, whichever management network model is chosen.';
