### Installer and deploy sequencing fixes (install)

- The application root is now re-owned through the directory the run is standing in (`chown_app_root_tree`), not through the `${APP_DIR}` pathname, in both `install.sh` and `update.sh`; a link at that name is refused.
- `scripts/backup.sh`, an unwired second reader of the root-side dump, publish and prune, is deleted. The application's own backup route and the pre-migration dump in `update.sh` are unchanged.
- `docs/installation.md` now places the crontab lock under `/etc/ims-cutover-state` throughout, and states that rolling back to a predecessor build must stop the service first.
- Regression guards: the openability rule now covers both halves of the decision, and `install.sh` takes the shared cutover lock before it adopts cutover state.
