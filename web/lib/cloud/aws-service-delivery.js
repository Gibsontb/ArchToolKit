export function awsServiceDelivery(input                                                                                                  )       {
 const lines=['# AWS service implementation', '', 'Service: '+input.service,'Region: '+input.region,'Expected account: '+(input.account||'Set and verify before deployment'),'',
 '## 1. Prerequisites','Use an authenticated AWS CLI profile for the intended account and partition. Confirm service availability, quotas, IAM permissions and required existing VPCs, subnets, security groups, keys and dependent resources for the selected resource. The catalog does not establish regional availability.','',
 'Run in this service directory. Keep credentials outside these files.','', '    aws sts get-caller-identity','',
 'Compare the returned Account and Arn with the intended deployment account and partition. Configure AWS_REGION for the selected region in your shell or profile.','',
 '## 2. Configure and validate','Review all generated inputs and resource files. Replace example values, resolve dependencies and select the intended backend/state boundary.',''];
 if(input.engine==='terraform')lines.push(
 '    terraform init','    terraform fmt -check','    terraform validate','    terraform plan -out=service.tfplan','    terraform show service.tfplan','',
 '## 3. Implement','Review the saved plan, including replacements, deletion, IAM and network changes. After approval, execute exactly that plan. Applying a saved plan does not prompt again.','',
 '    terraform apply service.tfplan','',
 '## 4. Verify','    terraform output','    terraform plan -detailed-exitcode','',
 'Confirm resource health in AWS and run the service-specific application/connectivity test. A second plan should show no unintended changes. Record resource IDs, outputs and test results.','',
 '## 5. Recovery','Use backups/snapshots and the service recovery procedure for data. Restore the previous reviewed configuration and plan before applying corrections. Terraform state alone is not a data backup; do not use destroy as rollback.','',
 'References: https://developer.hashicorp.com/terraform/cli/commands/plan and https://developer.hashicorp.com/terraform/cli/commands/apply');
 else if(input.engine==='cloudformation'){
 lines.push('Choose a unique stack name and authenticated CLI profile. Pass --region for this deployment in every command. The following commands use the example stack name service-stack.','',
 '    aws cloudformation validate-template --template-body file://template.json',
 '    aws cloudformation deploy --template-file template.json --stack-name service-stack --no-execute-changeset','',
 '## 3. Implement','Inspect the returned change-set ID using describe-change-set. Add IAM capabilities only when required and reviewed. Execute the approved change set using execute-change-set with that exact ID; then monitor describe-stack-events and describe-stacks.','',
 '## 4. Verify','Confirm CREATE_COMPLETE or UPDATE_COMPLETE and verify each resource and its application behavior. Record the stack ID, change-set ID and test results.','',
 '## 5. Recovery','Inspect failed stack events and rollback status before retrying. The template retains resources on deletion/replacement; retained resources continue to incur costs and require explicit lifecycle management. Retention is not a data backup.','',
 'Reference: https://docs.aws.amazon.com/cli/latest/reference/cloudformation/deploy.html');
 }
 else{
 const playbooks=Object.keys(input.files).filter(name=>/\.ya?ml$/.test(name));
 lines.push('Playbook and inventory files: '+playbooks.join(', '),'',
 '## 3. Implement','Use the generated README to identify the entry playbook, install its declared collections and configure its inventory. Run ansible-playbook --syntax-check, then --check --diff where the selected modules support check mode. Review changes before running the same entry playbook without --check.','',
 '## 4. Verify','Verify task results and resulting AWS resource health. Re-run supported idempotence checks and record resource identifiers and application/connectivity test results.','',
 '## 5. Recovery','Use the selected service backup/restore procedure and a reviewed configuration change. Do not assume reversing a task restores deleted data.');
 }
 return lines.join('\n')+'\n';
}
