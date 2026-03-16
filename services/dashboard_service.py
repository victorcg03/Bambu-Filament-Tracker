class DashboardService:
    def __init__(self, tracker):
        self.tracker = tracker

    def status_payload(self):
        status = {
            "connected": False,
            "job_name": "",
            "gcode_state": "UNKNOWN",
            "progress": 0,
            "nozzle_temp": 0,
            "bed_temp": 0,
            "test_mode": self.tracker.test_mode,
            "ams_info": {},
        }
        if self.tracker.test_mode:
            status.update(
                {
                    "connected": True,
                    "job_name": "benchy_v2.gcode",
                    "gcode_state": "RUNNING",
                    "progress": 47,
                    "nozzle_temp": 215,
                    "bed_temp": 60,
                }
            )
        elif self.tracker.bridge and hasattr(self.tracker.bridge, "state"):
            state = self.tracker.bridge.state
            status.update(
                {
                    "connected": self.tracker.bridge.mqtt_client is not None,
                    "job_name": state.job_name,
                    "gcode_state": state.gcode_state,
                    "progress": state.progress,
                    "nozzle_temp": state.nozzle_temp,
                    "bed_temp": state.bed_temp,
                }
            )
        status["ams_info"] = {str(k): v for k, v in self.tracker._ams_info.items()}
        status["tray_now"] = self.tracker._tray_now
        return status

    def dashboard_payload(self):
        with self.tracker._db_lock:
            conn = self.tracker.db.get_conn()
            try:
                total_spools = conn.execute("SELECT COUNT(*) AS c FROM spool_instances").fetchone()["c"]
                active_ams = conn.execute(
                    "SELECT COUNT(*) AS c FROM spool_instances WHERE archived = 0 AND last_ams_unit IS NOT NULL"
                ).fetchone()["c"]
                missing_sku = conn.execute(
                    "SELECT COUNT(*) AS c FROM spool_instances WHERE archived = 0 AND filament_product_id IS NULL"
                ).fetchone()["c"]
                low_stock = conn.execute(
                    "SELECT COUNT(*) AS c FROM spool_instances WHERE archived = 0 AND remaining_weight_g IS NOT NULL AND remaining_weight_g < ?",
                    (self.tracker.low_alert_grams,),
                ).fetchone()["c"]
                with_override = conn.execute(
                    """
                    SELECT COUNT(DISTINCT si.id) AS c
                    FROM spool_instances si
                    JOIN calibration_profiles cp
                      ON cp.scope_type = 'spool_instance'
                     AND cp.scope_id = CAST(si.id AS TEXT)
                    WHERE si.archived = 0
                    """
                ).fetchone()["c"]
                without_override = conn.execute(
                    """
                    SELECT COUNT(*) AS c
                    FROM spool_instances si
                    WHERE si.archived = 0
                      AND NOT EXISTS (
                        SELECT 1 FROM calibration_profiles cp
                        WHERE cp.scope_type = 'spool_instance'
                          AND cp.scope_id = CAST(si.id AS TEXT)
                      )
                    """
                ).fetchone()["c"]
                latest_runs = [
                    dict(row) for row in conn.execute("SELECT * FROM calibration_runs ORDER BY test_date DESC LIMIT 10").fetchall()
                ]
            finally:
                conn.close()

        return {
            "counts": {
                "total_spools": total_spools,
                "active_in_ams": active_ams,
                "spools_missing_sku": missing_sku,
                "low_stock": low_stock,
                "with_spool_override": with_override,
                "without_spool_override": without_override,
            },
            "latest_runs": latest_runs,
        }
