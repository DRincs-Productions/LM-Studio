# LoRA selection

Use an adapter only when its documented effect directly supports the request and its server registry entry is `ready` and compatible with the selected checkpoint. Provide registered IDs and numeric weights as structured `loras` entries. Use an empty array when the catalog has no documented match or when readiness, compatibility, or weight is unknown. Keep adapter loader syntax and paths out of prompts.

The current project catalog has no documented ready adapters. The RedCraft entry `flaccid_erect_krea2_loraholic` is pending quality validation. SNOFS has been retired. Add future ready entries here with profile, effect, documented trigger if any, and supported weight range. The server registry independently validates all selections.
