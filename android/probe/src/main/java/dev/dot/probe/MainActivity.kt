package dev.dot.probe

import android.app.Activity
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/**
 * A read-only report of what this watch actually is, built from APIs that only
 * tell the truth when run on the device itself — the real sensor list, the
 * display density, the heap cap and total RAM, which hardware features the
 * platform admits to. It also logs every key event it receives, to identify
 * the physical side button by keycode.
 *
 * It requests no permissions and runs no background service: the earlier build
 * that did the double-tap gesture needed overlay + touch-watching, which is the
 * shape Play Protect blocks. This one only reads and displays.
 */
class MainActivity : Activity() {

    private lateinit var keyLog: TextView
    private val keysSeen = StringBuilder()
    private lateinit var gestures: GestureDetector

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        val pad = (12 * resources.displayMetrics.density).toInt()
        root.setPadding(pad, pad, pad, pad)

        val report = TextView(this)
        report.textSize = 11f
        report.setTextIsSelectable(true)
        report.text = buildReport()

        val buzzButton = Button(this)
        buzzButton.text = "Buzz now (tap this button)"
        buzzButton.setOnClickListener { vibrate("button") }

        val hint = TextView(this)
        hint.textSize = 11f
        hint.text = "\n>> Or double-tap anywhere on this screen to buzz <<\n"

        keyLog = TextView(this)
        keyLog.textSize = 11f
        keyLog.text = "\nKey events seen: (press the side button)\n"

        root.addView(report)
        root.addView(buzzButton)
        root.addView(hint)
        root.addView(keyLog)

        val scroll = ScrollView(this)
        scroll.addView(root)
        setContentView(scroll)

        gestures = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: MotionEvent): Boolean {
                vibrate("double-tap")
                return true
            }
        })
    }

    // dispatchTouchEvent, not onTouchEvent: the ScrollView consumes touches, so
    // the activity's onTouchEvent never fired and the double-tap was never
    // seen. Dispatch runs before any child, so the detector always gets a look.
    // Returning super's result leaves the ScrollView's own scrolling intact.
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        gestures.onTouchEvent(event)
        return super.dispatchTouchEvent(event)
    }

    private fun vibrate(source: String) {
        val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        if (vibrator == null) {
            Toast.makeText(this, "no VIBRATOR_SERVICE", Toast.LENGTH_SHORT).show()
            return
        }
        val has = vibrator.hasVibrator()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // DEFAULT_AMPLITUDE can be ignored by an on/off-only (LED
                // trigger) vibrator; a plain long duration is the most
                // compatible request, so fall back to the pattern form too.
                vibrator.vibrate(VibrationEffect.createOneShot(1000, VibrationEffect.DEFAULT_AMPLITUDE))
            }
            @Suppress("DEPRECATION")
            vibrator.vibrate(longArrayOf(0, 1000), -1)
        } catch (e: Exception) {
            Toast.makeText(this, "vibrate threw: " + e.message, Toast.LENGTH_LONG).show()
            return
        }
        Toast.makeText(this, "buzz [$source] hasVibrator=$has", Toast.LENGTH_SHORT).show()
    }

    private fun buildReport(): String {
        val dm = resources.displayMetrics
        val rt = Runtime.getRuntime()
        val am = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val mem = android.app.ActivityManager.MemoryInfo()
        am.getMemoryInfo(mem)

        val sm = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensors = sm.getSensorList(Sensor.TYPE_ALL)

        val b = StringBuilder()
        b.append("WATCH PROBE\n\n")
        b.append("Model: ").append(Build.MODEL).append(" / ").append(Build.DEVICE).append("\n")
        b.append("Mfr: ").append(Build.MANUFACTURER).append("\n")
        b.append("Android ").append(Build.VERSION.RELEASE)
            .append(" (API ").append(Build.VERSION.SDK_INT).append(")\n")
        b.append("ABIs: ").append(Build.SUPPORTED_ABIS.joinToString(",")).append("\n\n")

        b.append("DISPLAY\n")
        b.append("  ").append(dm.widthPixels).append(" x ").append(dm.heightPixels).append(" px\n")
        b.append("  density ").append(dm.density)
            .append("  (").append(dm.densityDpi).append(" dpi)\n")
        b.append("  1 px = ").append(1f / dm.density).append(" dp\n\n")

        val vib = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        b.append("VIBRATOR\n")
        b.append("  present: ").append(vib?.hasVibrator()).append("\n")
        b.append("  amplitude control: ")
            .append(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) vib?.hasAmplitudeControl() else "n/a")
            .append("\n\n")

        b.append("MEMORY\n")
        b.append("  total RAM: ").append(mem.totalMem / (1024 * 1024)).append(" MB\n")
        b.append("  app heap cap: ").append(am.memoryClass).append(" MB\n")
        b.append("  large heap: ").append(am.largeMemoryClass).append(" MB\n")
        b.append("  JVM max: ").append(rt.maxMemory() / (1024 * 1024)).append(" MB\n")
        b.append("  low-RAM device: ").append(am.isLowRamDevice).append("\n\n")

        b.append("SENSORS (").append(sensors.size).append(")\n")
        if (sensors.isEmpty()) {
            b.append("  none reported\n")
        } else {
            for (s in sensors) {
                b.append("  [").append(s.type).append("] ").append(s.name)
                    .append(" / ").append(s.vendor).append("\n")
            }
        }
        b.append("\n")

        b.append("FEATURES\n")
        for (f in listOf(
            "android.hardware.camera",
            "android.hardware.camera.front",
            "android.hardware.bluetooth",
            "android.hardware.bluetooth_le",
            "android.hardware.wifi",
            "android.hardware.wifi.direct",
            "android.hardware.location.gps",
            "android.hardware.telephony",
            "android.hardware.nfc",
            "android.hardware.sensor.accelerometer",
            "android.hardware.sensor.gyroscope",
            "android.hardware.sensor.compass",
            "android.hardware.sensor.heartrate",
            "android.hardware.sensor.stepcounter",
        )) {
            b.append("  ").append(if (packageManager.hasSystemFeature(f)) "yes " else "no  ")
                .append(f.removePrefix("android.hardware.")).append("\n")
        }
        return b.toString()
    }

    private fun note(event: KeyEvent, phase: String) {
        keysSeen.insert(0, phase + " code=" + event.keyCode +
            " (" + KeyEvent.keyCodeToString(event.keyCode) + ")\n")
        keyLog.text = "Key events seen:\n" + keysSeen.toString()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        note(event, "DOWN")
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        note(event, "UP")
        return super.onKeyUp(keyCode, event)
    }
}
