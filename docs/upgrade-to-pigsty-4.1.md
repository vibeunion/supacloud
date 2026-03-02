# Upgrade to Pigsty 4.1 and Garage Compatibility Guide

This guide aims to help existing SupaCloud users (installed based on earlier Pigsty versions) smoothly upgrade to the latest Pigsty v4.1 for latest PostgreSQL support, better performance, and system security improvements.

## Important Notes

**Please make sure to backup core data before performing full infrastructure updates!**

Pigsty provides powerful automated deployment tools, but major version upgrades (especially when involving core PostgreSQL version adjustments) may come with configuration changes. Please carefully assess risk time windows before proceeding.

## Upgrade Method 1: Use One-Click Upgrade Script (Recommended)

SupaCloud provides a semi-automated upgrade helper script that you can directly execute on the server terminal:

```bash
cd /path/to/supacloud
bash scripts/upgrade_pigsty.sh
```

This script will automatically:
1. Download and build the latest v4.1.0 release codebase in your current user's home directory (`$HOME/pigsty`).
2. Automatically run `./configure`.
3. Execute `ansible-playbook` to redeploy updates for each component, completing in-place upgrade.

## Upgrade Method 2: Manual Upgrade (Follow Official Guide)

If you maintain a large number of custom host configuration items, or wish to execute step-by-step to control update scope, it's recommended to directly follow the commands in the Pigsty official manual:

1. **Download and checkout latest code**:
   ```bash
   curl -fsSL https://repo.pigsty.io/get | bash -s v4.1.0
   cd ~/pigsty
   ```
2. **Apply reconfiguration**:
   ```bash
   ./configure
   ```
3. **Step-by-step playbook upgrade**:
   Run playbooks individually according to the parts you need to update. For full system-wide application:
   ```bash
   ansible-playbook -i pigsty.yml install.yml
   ```

## Garage S3 Important Change Compatibility Supplement

The latest SupaCloud `install.sh` changed the default Region setting for self-hosted Garage S3 to enhance its API compatibility interaction with MinIO and standard S3 clients (which often use default configs like `us-east-1`).

If your older version encountered **AuthorizationHeaderMalformed** (auth signature header abnormal) errors from clients due to Garage S3's Region value (previously defaulted to `garage`), you can manually correct it for compatibility:

1. **Modify config file**: Edit `/etc/garage/garage.toml`, find the `[s3_api]` section
   Change `s3_region = "garage"` to:
   ```toml
   s3_region = "us-east-1"
   ```
2. **Modify credential environment variables (if used)**:
   Edit `/etc/garage/s3-credentials.env` and corresponding environment variable files in your projects, correct the `S3_REGION` value to `us-east-1`.
3. **Restart the engine**:
   ```bash
   systemctl restart garage
   ```
