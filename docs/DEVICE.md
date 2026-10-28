# The watch

Everything here was **measured or read off the device**, not taken from a spec
sheet. Several published and previously assumed figures turned out to be wrong,
and where a number used to be wrong that is noted, because the wrong one is
still floating around in older notes.

Sources: a read-only FTP session into internal storage (CX File Explorer's
"Access from PC"), the boot logcats the firmware itself writes to
`/sdcard/asrlog/boot_log/`, and a **small diagnostic app (`dev.dot.probe`) run
on the device** that reports what the framework APIs return directly. The watch
was not modified (the probe requests no permissions and runs no service).

The probe readings are the most authoritative source here — they are what the
hardware told its own OS — and where they settle an earlier inference from logs,
that is marked **[probe]**.

**Deliberately omitted:** the logs also contain the device's unique vendor id,
its IMSI/SIP identity and the SIM's phone number. None of that is recorded here,
on purpose — see [Privacy](#privacy-what-the-watch-sends-home).

---

## Identity

| | |
|---|---|
| Build fingerprint | `google/dove_watch/dove_watch:8.1.0/ORWT.044.01.250109/08131008:user/release-keys` |
| Codename | `dove_watch` |
| Android | **8.1.0** (API 27) |
| Build type | **`user` / `release-keys`** — not `userdebug` |
| Hardware id | `A9_XH025T_XH_20250422` |
| Firmware | `A9_EMMC_320386_5M_COMMON_OVERSEA_2025.08.13_10.10.51` |
| `Build.MANUFACTURER` | `google` **[probe]** |
| `Build.MODEL` | `google` **[probe]** |
| `Build.DEVICE` | `dov_watch` **[probe]** (the fingerprint's product is `dove_watch`) |
| **ABI** | **`arm64-v8a`**, then `armeabi-v7a`, `armeabi` **[probe]** — arm64 primary, confirmed |
| Vendor prefix | `sgtc` (every custom app is `com.sgtc.*`) |

The `MANUFACTURER` and `MODEL` both reading literally `google` is the firmware
dressing itself up as an AOSP reference build; it is not a Google device. Treat
those two fields as spoofed and identify the device by the `sgtc` packages and
the ASR hardware instead.
| Watch-face vendor code | `SJTC-A-SANJI` |

The firmware string decodes: **A9** platform, **eMMC** storage, **320×386**
display, **5 MP** camera, `COMMON_OVERSEA` international variant, built
2025-08-13.

`user/release-keys` matters: it means `ro.debuggable=0`, so ADB is off by default
and cannot be turned on from userspace.

### SoC — ASR Microelectronics "Dove"

Not MediaTek, which was the earlier guess. Evidence: the `asrlog` log directory,
the `asr-snd` audio driver, and the modem banner:

```
DOVE_1.097.011X_A38601_ :: DOVE_LWG_M15_A0_INT_MSA_1.097.012
Dove_3G_A6_8601_RFAPI_v11.54b
```

`LWG` = LTE / WCDMA / GSM. The modem is driven over an **AT command interface**
(`AT+CSCB=…` appears throughout the logs), and IMS/VoLTE registers.

---

## Display — 320 × 386, not 320 × 349

This supersedes the old figure. Three independent confirmations:

| Source | Value |
|---|---|
| Touch driver | `hyn_ts`, **size 320x385** |
| Firmware string | `320386` |
| Every stock watch-face filename | `SJTC-A-SANJI-**320X386**_F…` |

**320 × 386 is the panel. ~349 is what a WebView gets** — the previously
measured number was the viewport after system chrome, so roughly **37 px is
consumed by the status bar**. Both numbers are real; they answer different
questions. Design to 386 for a launcher or watch face, to 349 for a WebView app.

### Density — 160 dpi, density 1.0, so 1 px = 1 dp

Read straight off the framework:

```
DisplayMetrics{density=1.0, width=320, height=385, scaledDensity=1.0,
               xdpi=112.888, ydpi=77.611}
Config: sw320dp w320dp h349dp 160dpi smll port finger
        appBounds=Rect(0, 0 - 320, 385)
```

| | |
|---|---|
| `density` | **1.0** |
| Reported dpi | **160** (mdpi) |
| **1 px** | **= 1 dp exactly** |
| Resource qualifier | **`sw320dp`**, screen-size bucket `small` |
| App height in dp | **349 dp** with the status bar, 385 without |

This is the easiest possible case: **no px↔dp conversion is needed anywhere.**
Lay out in dp against 320 × 386 and it lands 1:1 on pixels. Put launcher
resources in `layout-sw320dp` / `values-sw320dp`.

`scaledDensity` also equals 1.0, so no font scaling is applied by default.

**Ignore `xdpi`/`ydpi`.** At 112.888 × 77.611 they are non-square and imply a
physically impossible panel for a watch — the firmware never set real physical
dimensions. `density=1.0` / `160dpi` is the figure that governs layout.

---

## Input — `/dev/input`

Four devices, all falling back to `Generic.kl` because the firmware ships **no
`.idc` or custom keylayout files** ("No input device configuration file found").

| Node | Name | Class | What it is |
|---|---|---|---|
| `event0` | **`hyn_ts`** | `0x15` touch | Hynitron touchscreen, 320×385, single display |
| `event1` | **`pmic_onkey`** | `0x01` key | The physical side button, straight off the PMIC |
| `event2` | `asr-snd Headset Jack` | `0x81` | Headset detect |
| `event3` | **`hall`** | `0x01` key | **Hall effect sensor** — magnet detect, reported as a key |

Notes that matter for writing a launcher:

- **There is no rotary encoder / crown.** Only the one button.
- `pmic_onkey` arrives as an ordinary key event, so a launcher sees it through
  normal key handling.
- `hall` is the interesting one: a magnetic sensor exposed as a **key device**,
  almost certainly the charging-cradle or cover detect. It can be watched like a
  button rather than through the sensor framework.
- The touch driver logs `could not query the properties of its associated
  display … inoperable until the display size becomes available` during early
  boot — harmless ordering noise, it recovers.
- `powerhint_config.xml` carries a `launcher_longclick_boost` CPU hint, so the
  firmware expects long-press to be a launcher gesture.

---

## GPS — works, but with real caveats

The vendor wraps it in `SgtcLocationComponent` ("add gps task" / "gps task
exist, do not reset task"), over the standard AOSP `GnssLocationProvider`.

**Present:**

- GNSS engine cycles normally — `GPS_STATUS_ENGINE_ON`, `SESSION_BEGIN`
- **AGPS over cellular**, keyed to the IMSI: `loc_eng_agps_init`,
  `loc_eng_agps_ril_init`, `loc_eng_agps_ril_set_imsi`,
  `loc_eng_agps_ril_update_network_availability`

**Missing — plan around these:**

| Log line | Consequence |
|---|---|
| `FLP HAL not supported` | No fused location provider |
| `GnssBatching interface is not implemented by HAL` | No batched location; you must hold a live request |
| `Hardware Activity-Recognition not supported` | No hardware activity/step recognition |
| `/data/vendor/gps/eph.bin, No such file or directory` | **No ephemeris cache — cold fixes will be slow** |
| `Error getting cell location info` | Cell-tower fallback is failing |

So: use `LocationManager` directly, expect a slow first fix, and do not reach for
the battery-efficient APIs because the HAL does not implement them.

---

## Sensors

- **Step counter** — real sensor, `register step counter sensor`
- **Heart rate** — `HeartRateTask`, `queryHeartRate`
- Exposed to apps through a vendor ContentProvider:
  `com.sgtc.netcenter2.component.provider.DataProvider.getStepRecordByDay(...)`

That provider is the supported way to read health data without touching sensors
directly. Watch faces already use it via `com.sgtc.clockbase.base.BaseClock`
(`queryStepCount`, `refreshStep`, `refreshHeartRate`).

Careful reading the logs: `PingSender` / `CoreClient` "heartBeat" is a **network
keepalive** to the vendor server (300 s, reset at 1800 s), nothing to do with the
heart-rate sensor.

---

## USB — the gadget stack is alive

This is the most important finding for the four pads on the back.

```
setUsbConfig(mtp)
Failed to switch USB config to mtp
Restoring empty function list (with ADB if enabled).
Bundle[{host_connected=false, connected=false, configured=false, mtp=true}]
/sys/class/android_usb/android0/f_rndis/ethaddr
option[15]=-agentlib:jdwp=transport=dt_android_adb,…
```

`UsbDeviceManager` is running, `/sys/class/android_usb/android0/` exists, the
stack **tries to come up as MTP on every boot**, and the ADB function is part of
its configuration. It fails only because nothing was plugged in —
`host_connected=false`.

**So D+ / D− are wired to the SoC.** The charging cradle being power-only is a
property of the cradle, not the watch. Four pads is exactly a USB 2.0 pinout
(VBUS, D−, D+, GND — USB 2.0 has four conductors, not five). If those pads are
brought out to a USB plug, the watch should enumerate as MTP.

ADB still needs `ro.debuggable` or developer options, which a `user` build does
not give — but MTP enumeration alone would confirm the wiring, and is the test
worth doing first.

---

## The launcher — `com.sgtc.launcher`

**Stock home app: `com.sgtc.launcher/.Launcher`.** Write that down; it is the way
back from any custom launcher.

```
START u0 {act=android.intent.action.MAIN cat=[android.intent.category.HOME]
          cmp=com.sgtc.launcher/.Launcher} from uid 0
am_proc_start: [0,1436,1000,com.sgtc.launcher,activity,…]
```

**It runs as uid 1000 (`system`)** — platform-signed, with privileges a
side-loaded launcher will not have. That does not block replacing it (HOME
resolution ignores uid) but it does mean parts of what it does cannot be
reimplemented by an ordinary app.

Its internals, from class names in the logs:

| Class | Role |
|---|---|
| `clock.ClockConstant.getClockPath` | resolves the active face from a path |
| `clock.CustomClockActivity` | the custom-face editor |
| `data.ClockRepository.getCurrentClockPre` | current face, persisted |
| `component.skin.SkinResources` | a **skinning system** |
| `bottommenu.CardOverlapFragment` | the overlapping-card bottom menu |
| `component.event.AppAndSkinLoadEvent`, `PopWindowEvent` | event bus |
| `broadcastreceiver.NetStateChangeReceiver` | connectivity |

### Watch faces are APKs on the SD card — and this is the low-risk path

`/sdcard/Android/clock_resource/` holds **13 watch faces**, each an APK plus a
matching PNG preview, with an `oat/` directory beside them (so they are really
loaded as code, dex-optimised in place):

```
SJTC-A-SANJI-320X386_F2024111124.apk  + .png
SJTC-A-SANJI-320X386_F2026032001.apk  + .png
…
```

Naming: `SJTC-A-SANJI-<width>X<height>_F<yyyymmddnn>`.

And `/sdcard/Android/customClock/` is a **user-editable face** — background
image, JSON config, and video:

```json
{ "fileData": "…/3807719652_bp.jpg", "fileType": "jpg", "imgFlag": 0,
  "timeColor": "ffffff", "timePosition": 8, "type": 3,
  "videoPath": "https://…/3807719652.mp4" }
```

Fields: `timeColor` as RRGGBB, `timePosition` as a slot index (8 here), `type` 3
for a video face, with `custom_clock_bg.jpg` and `custom_clock_video.mp4` beside
it. **A video watch face is supported.**

### Two different things, and an earlier claim here was too broad

This file previously called the face directory "the single cheapest
customisation route". That conflated two mechanisms which are not equally easy.
One face APK was pulled and inspected to settle it.

**The declarative custom face — genuinely easy.** `customClock/` is just a
background image, a 273-byte JSON and an optional MP4. No code, no install.
That route is as cheap as it looked.

**The installed faces are full Android apps.** The smallest one (59 KB) contains
exactly ten entries:

```
87800  classes.dex
 7088  resources.arsc
 2092  AndroidManifest.xml
       res/ — 4 PNGs and 1 XML, names shrunk to q3/dk/sn/c3/v9
       META-INF/com/android/build/gradle/app-metadata.properties
```

So: **Gradle-built, R8-minified, code-bearing APKs.** Writing one means writing
an Android app against the vendor's base class
(`com.sgtc.clockbase.base.BaseClock`, which the logs show exposes
`queryStepCount`, `queryHeartRate`, `refreshStep`, `refreshHeartRate`), not
authoring a data file.

### The face API's declared contract

From that APK's manifest:

| | |
|---|---|
| Package convention | **`com.sgtc.jiang.clock.f<id>`** (this one `f8118`) |
| **Required feature** | **`android.hardware.type.watch.sjtc`** |
| Permissions | `BLUETOOTH`, `BLUETOOTH_CONNECT`, `ACCESS_NETWORK_STATE` |

The `uses-feature` line is the important one. It is **not** the standard
`android.hardware.type.watch` — it is a **vendor-specific feature string this
firmware declares**. A face almost certainly has to declare it to be recognised,
and nothing outside this firmware family will satisfy it.

That a face requests Bluetooth and network access also says the faces are
expected to pull live data, not just render local sensor values.

---

## Installed apps

From `/sdcard/Android/data/` plus the vendor's own inventory report.

**Google / AOSP present:** `com.android.vending` (Play Store),
`com.google.android.gms`, `com.android.webview`, `com.android.dialer`,
`com.android.messaging`, `com.android.camera2`, `com.android.gallery3d`,
`com.svox.pico`.

**YouTube Lite is `com.YouTube.iT`** — version 1.0. Note the capitalisation: a
third-party package, not Google's.

**Vendor apps** (`com.sgtc.*`): `appstore`, `charge`, `clockshop2`, `countdown`,
`erwma` (QR), `flashlight`, `intercom`, `introduce`, `music`, `netcenter`,
`noise`, `provider`, **`satellitesearch`** (the GPS tool), `sedentary`,
`settime`, `sgclass` (school mode), `sgtcimei`, `sos`, `soundrecorder`,
`stopwatch`, `terabox`, `wechat2`, `xh.nfc`. Plus `com.qdaytek.watch3d`,
`com.sg.calculator`, and two shipped under a placeholder id:
`com.example.sgtcappma`, `com.example.sgtczxing`.

**OTA:** `com.abupdate.fota_demo_iot` — ABUpdate, still carrying `demo` in the
package name.

**Ours:** `dev.dot`.

---

## Family Link — supervision, but no device owner

A correction to an earlier assumption. The log says plainly:

```
Set ro.device_owner property to false
```

while Family Link is unmistakably active inside GMS:

```
com.google.android.gms.kids.features.timelimit.TimeLimitCheckingIntentOperation
com.google.android.gms.kids.operations.KidsPackageIntentOperation
com.google.android.gms.kids.database.SupervisionDatabase
```

So supervision runs **as a GMS component, not as a Device Policy Controller**,
and the device-owner slot is empty. The earlier claim that Family Link occupies
it was wrong.

That does not make `dpm set-device-owner` available: it still refuses once any
account exists on the device, and provisioning requires a factory reset — which
on a supervised device risks needing re-enrolment through the parent account.
Same conclusion, different reason.

---

## Privacy — what the watch sends home

Worth knowing, and the reason identifiers are omitted from this file.

The watch periodically uploads an **inventory of installed apps and their
versions** to a vendor endpoint, in a `DSSYNCUP` record keyed to its unique
device id, alongside the hardware and firmware strings.

Custom watch-face assets are fetched from vendor hosts by that same device id —
one plain **`http://`** endpoint on a bare IP, and one `https://` host.

The boot logcats on the SD card contain the device id, the SIM's phone number,
the IMS/SIP identity and the carrier APN. **They are world-readable to any app
with storage permission**, and anything that can read `/sdcard` can read them.
Treat `/sdcard/asrlog/` as sensitive before sharing it.

---

## What could not be reached, and why

- **`/system` is not readable this way.** CX's FTP share is rooted at
  `/storage/emulated/0`, so `build.prop`, `/system/app` and `/system/priv-app`
  are outside it. Everything above was recovered from logs instead. If CX can be
  told to share `/` the rest becomes available.
- **Installed APKs cannot be decompiled from here.** They live in `/data/app`,
  which is not in the share — only `com.sgtc.countdown_2.apk` sits loose in
  `/sdcard/app`. So `com.YouTube.iT` and the vendor apps were characterised from
  their runtime behaviour, not their code.
- **The watch-face APKs in `clock_resource/` *are* reachable**, and are the one
  place where the vendor's own API surface could be read directly.

---

# Build points

The specific hardware facts a replacement UI has to be written against. Kept
short on purpose — this is the list of things that constrain the build, not an
inventory.

## Camera — one, and it owns the torch

```
Camera provider legacy/0 ready with 1 camera devices
Camera device device@3.3/legacy/0 torch status is now AVAILABLE_OFF
CameraService::connect … camera ID 0 … Camera API version 2
```

| | |
|---|---|
| Cameras | **exactly one** (`id=0`) |
| Sensor | 5 MP (from the firmware string) |
| HAL | `legacy/0`, provider `@2.4`, device `@3.3` |
| API | **Camera2 is supported** |

Two consequences:

- **There is no front/rear switch to build.** One camera, so any "flip camera"
  affordance is dead UI on this device.
- **The flashlight *is* the camera torch.** Torch state is reported through
  `torch_mode_status_change` on camera 0, so it is driven with
  `CameraManager.setTorchMode()` — not a separate LED device. It goes
  `NOT_AVAILABLE` while the camera is open, so a torch toggle has to handle
  being locked out mid-session.

A `CAMERA_LAUNCH` power hint exists, so the firmware expects camera start to be
a boost-worthy event.

## Audio — speaker, mic, one primary output

```
AUDIO_ROUTE, Entering state QuiescentSpeakerRoute
Control 'DAC-1 Right Shift Bits' … in path 'speaker-and-headphones'
Using module 10 as the primary audio interface
HAL output buffer size 1920 frames / 240 frames
```

- Mixer path is **`speaker-and-headphones`** — built-in speaker plus the headset
  jack on `event2`; no other output route reachable
  (`Output device 00100000 unreachable`)
- Single primary audio interface, 3000 ms standby
- Microphone is real — SoundRecorder and the noise-meter app both use it
- **No hotword/soundtrigger**: `Could not get passthrough implementation for
  soundtrigger@2.0::ISoundTriggerHw` — so no always-listening wake word

## Vibration — on/off only

```
Vibrator using LED trigger
android.hardware.vibrator@1.0::IVibrator/default
```

The haptic is driven **through the LED subsystem**, behind vibrator HAL **1.0**.
That means a plain on/off motor: **no amplitude control, no waveform
composition, no `VibrationEffect` primitives.** Design haptics as simple
durations; anything richer silently degrades to buzz-or-nothing.

**Confirmed on-device [probe]:** the `dev.dot.probe` app vibrates correctly with
a plain duration. Two things had to be right:

- Drive it with a **duration**, not amplitude. `VibrationEffect.createOneShot`
  with `DEFAULT_AMPLITUDE` is ignored by this LED-trigger vibrator; the
  deprecated `vibrate(longArrayOf(0, 1000), -1)` pattern form works. A build
  that only tried the amplitude API produced no buzz at all.
- This is unrelated to vibration but bit the same test: a gesture detector must
  be fed from `dispatchTouchEvent`, because a `ScrollView` consumes touches
  before the activity's `onTouchEvent` runs, and the double-tap was never seen.

## SIM — one physical slot, LTE

| | |
|---|---|
| Slots | **one** (`simSlotIndex=0`, a single `SubscriptionInfo`) |
| Type | **physical** — `isEmbedded false`, so no eSIM |
| State | `simState=5` (READY) |
| Radio | **LTE** — `mRilVoiceRadioTechnology=14`, `mRilDataRadioTechnology=14` |
| IMS | registers; VoLTE works |
| Max data calls | 15 |

Worth noting the RF banner says `Dove_3G_…` but the radio actually attaches on
**LTE**. Trust the registration state, not the firmware string.

The modem is reachable over an **AT command interface** — the logs show live
`AT+CSCB=…` cell-broadcast configuration being written.

*Carrier, ICCID, MSIN, IMSI and the SIM's phone number all appear in the logs
and are deliberately not recorded here.*

## Feature flags — what the platform admits to [probe]

`PackageManager.hasSystemFeature(...)`:

| Feature | Result |
|---|---|
| camera | **yes** |
| camera.front | **yes** ⚠ |
| bluetooth | yes |
| bluetooth_le | yes |
| wifi | yes |
| wifi.direct | **no** |
| location.gps | yes |
| telephony | yes |
| nfc | **no** ⚠ |
| sensor.accelerometer | yes |
| sensor.gyroscope | yes |
| sensor.compass | yes |
| sensor.heartrate | **no** ⚠ |
| sensor.stepcounter | yes |

Three of these contradict other evidence, and the contradictions are
instructive:

- **`camera.front = yes`, but the camera HAL enumerated only one camera.**
  The feature flag is over-declared. Do **not** trust it to mean a second
  camera exists — the HAL is authoritative, and it found one. There is no
  front/rear switch to build.
- **`nfc = no`, yet `com.sgtc.xh.nfc` is installed** as a user app. Either the
  NFC app is dead weight the firmware ships regardless, or NFC is wired but the
  platform feature was never declared. Treat NFC as **not usable through
  standard APIs** until proven otherwise.
- **`heartrate = no`, yet the heart-rate sensor is in the sensor list.** The
  sensor is real (use `TYPE_HEART_RATE` directly); the feature flag just was
  not declared. Don't gate heart-rate code on `hasSystemFeature`.

`wifi.direct = no` is consistent with the old `wpa_supplicant` — no P2P.

The lesson: **feature flags on this firmware are unreliable in both
directions.** Enumerate the actual hardware (sensors, cameras) rather than
trusting the declared features.

---

## Radios and connectivity — verified

### WiFi — present, 2.4 GHz, **WPA2 only**

```
Enumerate - Interface "wlan0" is DOWN / detected as Ethernet device
COUNTRY AU
BTCOEXSCAN-STOP
Invalid configuration line 'sae_pwe=2'
Invalid configuration line 'oce=1'
Offload HAL not supported / No Offload Service available
```

| | |
|---|---|
| Interface | `wlan0` |
| Regulatory domain | **AU** |
| **WPA3 / SAE** | **not supported** — `wpa_supplicant` rejects `sae_pwe` as an unknown key |
| OCE | not supported (same reason) |
| Offload HAL | **absent** — no APF packet filtering, so limited wake-on-WLAN |
| Antenna | **shared with Bluetooth** — `BTCOEXSCAN` coexistence commands confirm a combo chip |

The `sae_pwe` rejection is load-bearing: this is an **old `wpa_supplicant` with no
WPA3**. On a WPA3-only network the watch cannot associate at all. Keep a
WPA2 or mixed-mode SSID available.

Only 2.4 GHz channel plans appear anywhere in the logs; no 5 GHz channel list
was seen, so treat it as **2.4 GHz only** until proven otherwise.

### Bluetooth — present, Classic **and** BLE

- `BluetoothManagerService`, `LocalBluetoothProfileManager construction complete`
- `Adding local MAP profile` — Message Access Profile, so BT message sync exists
- GMS Bluetooth trustlet initialises (Smart Lock path)
- **BLE is actively used by the vendor**: `com.sgtc.ble` ships a `BleService`
  with its own `AsrCoder` / `AsrEncryptCoder` — Kotlin, Hilt, MMKV — almost
  certainly the companion-phone pairing channel

Bluetooth was switched **off** during this boot, so profile support beyond MAP
was not observed.

### Hotspot / tethering — configured, not observed running

```
2G band allowed channels are:1,6,11
Setting IP forward enable = 0
```

The SoftAP band configuration and the tethering IP-forward path both exist, so
hotspot is **built into this firmware**. Channels 1/6/11 means **2.4 GHz only**.
It was not active during this boot, so it is "present and configured" rather
than "confirmed working".

### SMS — fully enabled, send and receive

```
ctor mSmsCapable=true format=3gpp mSmsSendDisabled=false
GsmSMSDispatcher created / CdmaSMSDispatcher created / ImsSMSDispatcher created
[ImsSmsManager] setListener …
created InboundSmsHandler
```

| | |
|---|---|
| `mSmsCapable` | **true** |
| `mSmsSendDisabled` | **false** — sending is not blocked |
| Format | **3gpp** (GSM/LTE); a 3gpp2 dispatcher also exists but is unused |
| SMS over IMS | available — `ImsSMSDispatcher` + `ImsSmsManager` listener |
| Inbound | `InboundSmsHandler` running |

So SMS works both ways, and a replacement UI can use `SmsManager` normally.

---

## Sensors — the full list, read from the device [probe]

`getSensorList(TYPE_ALL)` on the watch returns **12 sensors**. This is the
definitive list and it settles every earlier guess:

| # | Sensor | Note |
|---|---|---|
| 1 | **G-sensor (accelerometer)** | the base motion sensor |
| 2 | **Magnetometer** | raw compass |
| 3 | **Pressure** | a barometer — more than expected on a watch this cheap |
| 4 | **Temperature** | ambient/device temp |
| 5 | Orientation | legacy fused (deprecated API, still offered) |
| 6 | **Step detector** | per-step event |
| 7 | **Significant motion** | one-shot "started moving" wake |
| 8 | **Tilt** | wrist-tilt |
| 9 | **Step counter** | cumulative |
| 10 | **Heart rate** | needs `BODY_SENSORS` |
| 11 | Wake gesture | wrist-raise-to-wake |
| 12 | Geomagnetic rotation vector | fused orientation without the gyro |

The feature flags (next section) separately report **accelerometer,
gyroscope and compass all present**, so a gyroscope exists even though the
list names fused/derived sensors rather than a raw `gyroscope` entry.

What is **not** there: **no light sensor and no proximity sensor.** So
auto-brightness and any "covered" detection are not available — brightness must
be a manual control.

### Earlier confusion, now resolved

Two earlier readings of the *logs* each looked like a sensor enumeration and
were not — recorded here so the mistakes are not repeated:

- `Reporting Mode incorrect: sensor Heart Rate Sensor … / Wake Gesture
  Sensor …` was `sensorservice` flagging **two HAL bugs**, not listing the
  hardware. Those two reporting-mode defects are real — the heart-rate and
  wake-gesture sensors are mis-declared — so their event cadence may not match
  the documented semantics; test empirically.
- `5 Sensors parsed successfully` came from the **thermal** HAL (five thermal
  zones), nothing to do with motion sensors.

### There is a sensor hub — which is why the logs never list them

The reason three boot logs never print a sensor enumeration: **the sensors are
not on the application processor.** A `nanohub` service is running, and it
complains on every single boot:

```
W/nanohub: Illegal otc_gyro data size = 0
```

`nanohub` is Android's **sensor-hub HAL** — a low-power co-processor that owns
the sensors and reports them up. It enumerates over its own transport, not into
logcat, so no amount of log mining will produce the list. That is a dead end,
not a gap in the search.

Two things follow:

- **A gyroscope is very likely fitted.** `otc_gyro` is the sensor hub's
  *online temperature calibration* blob **for a gyroscope*. The hub firmware
  would not be asking for it otherwise. This is strong evidence rather than
  proof — a stock nanohub build could carry the path regardless of what is
  soldered on.
- **Its calibration is broken.** `data size = 0` on all three boots means the
  calibration blob is empty, so gyro temperature compensation is not running.
  Expect drift, and do not trust raw gyro values for anything cumulative.

A sensor hub is also good news for battery: step counting and wake-gesture
detection happen off the main CPU.

### The HAL's reporting modes are wrong — plan for it

Both sensors it does name are mis-declared:

- **Heart rate** declares `actual=0` (continuous) where Android expects `1`
  (on-change)
- **Wake gesture** declares `actual=1` (on-change) where Android expects `2`
  (one-shot)

This is a vendor HAL defect, present on every boot. Standard `SensorManager`
registration may therefore deliver events at the wrong cadence, or a one-shot
trigger may not behave as a trigger. Test both empirically rather than trusting
the documented semantics.

## Camera — additional measured detail

```
streamId[0/1]=_CALLBACK(2), width=640, height=480, format=1
costTime=1406ms … stream configure
```

Preview configures at **640 × 480**, and stream configuration cost **1406 ms**
on one run. Camera start is slow enough that a UI needs to show it is working.

Two device handles appear in the logs, but both are `deviceID=0` — concurrent
sessions on the one camera, not a second camera. **One camera, confirmed** (and
confirmed again by the owner).

### Camera2 will report LEGACY

The provider is `legacy/0` and the logs are full of `legacy_enum_conversion`
calls, which is the **HAL1-to-HAL3 shim**. So
`INFO_SUPPORTED_HARDWARE_LEVEL` will come back `LEGACY`, not LIMITED or FULL.

Consequences: no manual sensor control, no RAW capture, no reprocessing, and
burst/high-speed modes unavailable. Camera2 is usable, but only at roughly the
capability of the old Camera1 API.

---

## Battery, power and thermals

```
I/battery_status: [2,3,1,1,Li-poly]
I/battery_level:  [99,4258,420]
```

| | |
|---|---|
| Chemistry | **Li-poly** |
| Level at this boot | 99 % |
| Voltage | **4258 mV** — a single 4.2 V cell |
| **Temperature** | **42.0 °C**, while charging |
| Status | charging, health good, plugged in |

Capacity in mAh is **not** in the logs.

42 °C on the charger is worth noting: it supports the throttling seen in the
JavaScript benchmarks, and it is the mechanism behind "unplug it if you want it
responsive".

### A notification LED exists, and its HAL is broken

```
W/qdlights: write_int origin failed to open /sys/class/leds/red/rgb_start
```

There is an RGB LED under `/sys/class/leds/`, but the lights HAL (`qdlights`)
fails to open `rgb_start` — so the LED is present in the kernel and **not
drivable through the normal path**. This is the same `leds` subsystem the
vibrator is wired into (`Vibrator using LED trigger`).

### Thermal throttling — the mechanism, in the firmware's own words

`android.hardware.thermal@2.0-service.asr` parses **5 thermal zones** and
registers **5 cooling devices**. This is what produces the wide spread in the
JavaScript benchmarks, and it is worth reading literally:

| Cooling device | Max state | What it throttles |
|---|---|---|
| **`asr-cpufreq-0`** | **6** | **the CPU — 7 frequency steps** |
| `asr-gpufreq-0` | 5 | the GPU |
| **`asr-vpu-clk`** | **8** | **the video processing unit** |
| `thermal-devfreq-0` | 4 | memory/bus frequency |
| `pm813-batt-in-curr` | 5 | charge current |

So the CPU has **seven frequency states a thermal governor moves it between**,
polled every 2–10 s. A benchmark that reads 27 ms once and 190 ms another time is
not noisy measurement — it is the governor doing its job at different
temperatures.

With the battery observed at **42 °C on the charger**, the device sits inside the
range where this is active. "Unplug it if you want it responsive" is a real
mitigation, not folklore.

Other facts from the same service:

- The PMIC is an **ASR PM813** (`pm813-battery`, `pm813-batt-in-curr`)
- Battery hot threshold is **60 °C** with 3 ° hysteresis
- The thermal config declares **`is_watch: true`**
- **A VPU exists** (`asr-vpu-clk`) — there is hardware video decode, which
  matters both for the video watch faces and for the WebView's video crashes
- Parts of the config are broken: `fail to update pm813-battery trip point`,
  and `pmic-temp: all thresholds are NAN`

#### A trap worth recording

The line `5 Sensors parsed successfully` looks like the motion-sensor
enumeration this file has been missing. **It is not.** It comes from the
*thermal* HAL and those five "sensors" are thermal zones. Accelerometer,
gyroscope and compass remain unknown.

### Memory — and a spoofed RAM figure [probe]

| | |
|---|---|
| `ActivityManager.memoryClass` (app heap cap) | **256 MB** |
| `largeMemoryClass` | **512 MB** |
| `Runtime.maxMemory()` | **256 MB** |
| `isLowRamDevice()` | **true** |
| Per-app heap cap (from logs) | matches: `-XX:HeapGrowthLimit=256m` |
| zram | configured (`zram0` node) |
| lmkd | modern, PSI pressure monitors |

**`totalMem` reports ~15,253 MB (≈16 GB), and that figure is not real.** It
cannot coexist with `isLowRamDevice=true` and a 256 MB heap cap. These watches
are known to bake an inflated RAM/storage number into the firmware to advertise
"16 GB"; this is that number. **Real usable RAM is small** — treat the low-RAM
flag and the 256 MB heap as the truth and the 16 GB as marketing. (It matches
the "16 GB" figure that was half-remembered early on — advertised, not actual.)

The low-memory killer's protection whitelist is ordered
`com.tencent.mm` → `com.tencent.mm:push` → `com.sgtc.launcher` →
`com.sgtc.twecall`, so **WeChat is protected ahead of the launcher** on this
firmware — which matters more given how little real RAM there is.

Total RAM is **still unknown**: `MemTotal` appears in neither boot log. zram
being enabled is itself a strong hint this is a low-RAM configuration.

### Storage size could not be read — even by Android

```
avc: denied { read } for path="/sys/kernel/debug/mmc0/mmc0:0001/ext_csd"
       scontext=u:r:storaged:s0
```

SELinux blocked the system's own `storaged` from reading the eMMC's `ext_csd`,
which is where capacity lives. The device is `mmc0:0001` (eMMC, matching the
`A9_EMMC_…` firmware string) but its size is not recoverable from these logs.

---

## SELinux is enforcing

`permissive=0` on every denial across both logs. This is **not** a permissive
build.

That matters for any plan that involves reading or writing `sysfs`, `debugfs` or
vendor nodes directly: untrusted apps are blocked, and the logs already show it
happening — an app was denied `search` on `zram0`, and `storaged` itself was
denied the eMMC descriptor. Stick to framework APIs.

## Other sensors worth knowing

- **Face unlock exists** (`com.sgtc.faceunlock`), so the camera is already wired
  to an auth path
- Heart rate lives in `com.andoid.hrsblood` — note the vendor's own typo in that
  package name; it is `andoid`, not `android`, and matching on the correct
  spelling will fail
- Steps in `com.sgtc.stepcalculate`

---

## The launcher's app model

The stock launcher logs its own data structures, which gives the exact shape a
replacement should mirror:

```
AppInfo(packageName='com.sgtc.clockshop2', sort=0)
AppInfoUI(ClockShop, ComponentInfo{com.sgtc.clockshop2/com.sgtc.clockshop2.main.MainActivity})
```

So: a persisted list of `(packageName, sort)` resolved at load time into
`(label, ComponentName)`. Order is **explicit and user-arrangeable**, not
alphabetical — `loadAppInfoUI` reads the sort indices straight through.

### Settings is NOT `com.android.settings`

This corrects the escape-hatch target. The device's own Settings app is:

```
com.sgtc.settings/com.sgtc.settings.MainActivity
```

An `Intent(Settings.ACTION_SETTINGS)` may still resolve, but the component to
launch explicitly is the `sgtc` one. Likewise several AOSP-looking apps are
vendor replacements under vendor activities — e.g. the alarm is
`com.android.deskclock/com.sgtc.alarmclock.SgtcAlarmListActivity`, and video is
`com.android.gallery3d/com.sgtc.videoplayer.VideoActivity`.

### Components worth launching directly

| Purpose | Component |
|---|---|
| Settings | `com.sgtc.settings/.MainActivity` |
| Watch-face picker | `com.sgtc.clockshop2/com.sgtc.clockshop2.main.MainActivity` |
| Camera | `com.android.camera2/com.android.camera.CameraLauncher` |
| Phone | `com.sg.sgphone/com.sg.sgphone.FunctionActivity` |
| Contacts | `com.sg.contact/…AllContactActivity` |
| Call log | `com.sgtc.calllog/…CalllogActivity` |
| Steps | `com.sgtc.stepcalculate/…MainActivity` |
| Heart rate | `com.andoid.hrsblood/com.sgtc.HeartRateActivity` |
| Flashlight | `com.sgtc.flashlight/.MainActivity` |
| YouTube Lite | `com.YouTube.iT/com.YouTube.iT.MainActivity` |
| Play Store | `com.android.vending/.AssetBrowserActivity` |
| Family Link | `com.google.android.apps.kids.familylinkhelper` |

Also installed but absent from `/sdcard/Android/data` (so only visible through
the launcher's list): Gboard (`com.google.android.inputmethod.latin`), Assistant
Go, Meet (`…apps.tachyon`), Google Contacts and Messages, Telegram
(`org.telegram.messenger.web`), and the vendor's Walkie-Talkie
(`com.sgtc.intercom`), Drink Reminder, Good Habit, Interactive Dials, Auto-clear
and Screen Capture.

**Family Link is confirmed installed** — it appears in the launcher's app list
even though it has no external data directory.
