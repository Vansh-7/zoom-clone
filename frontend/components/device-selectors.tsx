export function DeviceSelectors({
  devices,
  selected,
  pending,
  onSelect,
}: {
  devices: MediaDeviceInfo[];
  selected: { audio: string; video: string };
  pending: boolean;
  onSelect: (kind: "audio" | "video", id: string) => Promise<void>;
}) {
  return (
    <div className="device-settings">
      <div
        className="device-selectors"
        role="group"
        aria-label="Media device selection"
      >
        {(["video", "audio"] as const).map((kind) => {
          const name = kind === "video" ? "Camera" : "Microphone";
          const options = devices.filter(
            (device) => device.kind === `${kind}input` && device.deviceId,
          );
          return (
            <label key={kind}>
              {name}
              <select
                value={selected[kind]}
                disabled={pending}
                onChange={(event) => void onSelect(kind, event.target.value)}
              >
                <option value="">System default</option>
                {options.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `${name} ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      <p className="device-note">
        {!devices.some((device) => device.label) &&
          "Allow device access to see camera and microphone names. "}
        Speaker output uses your browser or system settings.
      </p>
    </div>
  );
}
