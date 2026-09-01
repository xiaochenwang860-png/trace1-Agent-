variable "region" {
  description = "Volcengine region, for example cn-beijing."
  type        = string
}

variable "zone_id" {
  description = "Availability zone that has inventory for the chosen instance type."
  type        = string
}

variable "image_id" {
  description = "A public Ubuntu 22.04/24.04 image ID in the selected region."
  type        = string
}

variable "instance_type" {
  description = "ECS instance type. 2 vCPU / 4 GiB or larger is recommended."
  type        = string
  default     = "ecs.g4i.large"
}

variable "key_pair_name" {
  description = "Existing ECS SSH key-pair name."
  type        = string
}

variable "project_name" {
  description = "Volcengine project."
  type        = string
  default     = "default"
}

variable "allowed_web_cidr" {
  description = "CIDR allowed to access the web UI. This must be an explicit, restricted network."
  type        = string
  validation {
    condition     = var.allowed_web_cidr != "0.0.0.0/0"
    error_message = "allowed_web_cidr must not expose this code-execution POC to the entire Internet."
  }
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to SSH to the ECS."
  type        = string
}

variable "repository_url" {
  description = "Public Git URL of this Starter Kit repository."
  type        = string
  validation {
    condition     = startswith(var.repository_url, "https://")
    error_message = "repository_url must be an HTTPS URL."
  }
}

variable "repository_ref" {
  description = "Git branch or tag deployed by cloud-init."
  type        = string
  default     = "main"
}

variable "ark_api_key" {
  description = "Volcengine Ark API key. Supplied through TF_VAR_ark_api_key."
  type        = string
  sensitive   = true
}

variable "app_auth_token" {
  description = "Shared browser/API demo token. Supplied through TF_VAR_app_auth_token."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.app_auth_token) >= 24 && length(var.app_auth_token) <= 128 && can(regex("^[A-Za-z0-9._~-]+$", var.app_auth_token)) && !startswith(var.app_auth_token, "replace-")
    error_message = "app_auth_token must contain 24-128 URL-safe, non-placeholder characters."
  }
}

variable "trace_viewer_token" {
  description = "Developer-only Glass Box token. Supplied through TF_VAR_trace_viewer_token."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.trace_viewer_token) >= 24 && length(var.trace_viewer_token) <= 128 && can(regex("^[A-Za-z0-9._~-]+$", var.trace_viewer_token)) && !startswith(var.trace_viewer_token, "replace-")
    error_message = "trace_viewer_token must contain 24-128 URL-safe, non-placeholder characters."
  }
}

variable "recovery_operator_token" {
  description = "Recovery write token, separate from the read-only trace viewer token. Supplied through TF_VAR_recovery_operator_token."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.recovery_operator_token) >= 24 && length(var.recovery_operator_token) <= 128 && can(regex("^[A-Za-z0-9._~-]+$", var.recovery_operator_token)) && !startswith(var.recovery_operator_token, "replace-")
    error_message = "recovery_operator_token must contain 24-128 URL-safe, non-placeholder characters."
  }
}

variable "recovery_operator_id" {
  description = "Stable operator identity recorded in recovery audit events. Supplied through TF_VAR_recovery_operator_id."
  type        = string
  validation {
    condition     = length(var.recovery_operator_id) >= 1 && length(var.recovery_operator_id) <= 64 && can(regex("^[A-Za-z0-9_.-]+$", var.recovery_operator_id))
    error_message = "recovery_operator_id must contain 1-64 URL-safe identity characters."
  }
}

variable "ark_model" {
  description = "Ark endpoint/model ID supporting the Responses API."
  type        = string
}

variable "ark_base_url" {
  description = "Ark OpenAI-compatible API base URL."
  type        = string
  default     = "https://ark.cn-beijing.volces.com/api/v3"
}
