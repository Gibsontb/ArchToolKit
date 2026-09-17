variable "region" { type = string }
variable "naming_prefix" { type = string }
variable "max_azs" { type = number default = 2 }
variable "vpcs" {
  type = list(object({
    name = string
    cidr = string
    subnets = list(object({
      name = string
      cidr = string
      role = string
    }))
  }))
}
