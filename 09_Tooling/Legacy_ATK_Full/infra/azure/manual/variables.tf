variable "location" { type = string }
variable "naming_prefix" { type = string }

variable "vnets" {
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
