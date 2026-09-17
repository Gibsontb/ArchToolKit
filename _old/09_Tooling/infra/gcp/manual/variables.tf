variable "project_id" { type = string }
variable "region" { type = string }
variable "naming_prefix" { type = string }

variable "networks" {
  type = list(object({
    name = string
    subnets = list(object({
      name = string
      cidr = string
      role = string
    }))
  }))
}
