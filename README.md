# homebridge-linksys-velop

Linksys Velop parental controls in Apple Home.

Pause a child's device from the Home app, from Siri or from an automation,
switch its bedtime schedule on or off, and see whether the device is connected.

**Built for and tested on the Linksys Velop MX4200.** It talks to the router with
the same local protocol the Linksys app uses (JNAP), so other Velop and Linksys
Smart Wi-Fi models are likely to work as well, but only the MX4200 has been tested.

- No cloud account. The plugin only talks to the router on your own network.
- No dependencies, and nothing to set up outside Homebridge.
- Works side by side with the Linksys app: a change made in either place shows up in the other.

## What you get in Apple Home

Every device that is under **Parental Controls** in the Linksys app is added
automatically, with:

| Tile | What it does |
| --- | --- |
| **Pause** switch | On = the device has no internet (the same as *Pause* in the Linksys app). Off = internet is back. |
| **Schedule** switch | On = the device follows its pause schedule, for example "pauses at 22:00". Off = no schedule. |
| **Connected** sensor | Shows whether the device is connected to the network right now. |

Optionally, a **Restart Router** switch.

### How Pause and Schedule work together

- Turning **Pause** off puts the device back on its schedule if the **Schedule** switch is on, and fully online if it is off.
- Flipping **Schedule** while the device is paused does not lift the pause. It only decides what happens when the pause ends.
- The router forgets a device's schedule while the device is paused. The plugin remembers it for you and puts it back.
- A device that was already paused when the plugin first saw it has no known schedule. Its **Schedule** switch starts off, and switching it on applies the default schedule from the settings (22:00 to 06:00).

### Ideas for automations

- Pause every console when the last parent leaves home.
- Turn the **Schedule** switch off on Friday evening and back on on Saturday night.
- "Hey Siri, turn on PlayStation Pause."
- Get a notification when a console connects to the network.

## Install

Search for **Linksys Velop** in the Homebridge UI plugin tab, or:

```sh
npm install -g homebridge-linksys-velop
```

Then open the plugin settings and fill in:

- **Router address**: the IP address of the main Velop node (the one connected to the modem). The Linksys app shows it under the node's details; it is usually also your network's gateway address.
- **Router admin password**: the password used to manage the router. This is not the Wi-Fi password and not your Linksys cloud account password.

Restart Homebridge. The devices appear in the Home app.

## Settings

```json
{
  "platform": "LinksysVelop",
  "name": "Linksys Velop",
  "host": "192.168.1.1",
  "password": "router admin password"
}
```

Everything else is optional:

| Setting | Default | Meaning |
| --- | --- | --- |
| `autoDiscover` | `true` | Add every device that has a parental-control rule on the router. |
| `pauseSwitches`, `scheduleSwitches`, `presenceSensors` | `true` | Which tiles each device gets. |
| `rebootSwitch` | `false` | Add a switch that restarts the router. |
| `pauseSwitchMode` | `"pause"` | `"pause"`: on = internet paused. `"internet"`: on = internet allowed. |
| `presenceSensorType` | `"occupancy"` | `"occupancy"`, `"motion"` or `"contact"`. |
| `defaultPauseStart`, `defaultPauseEnd` | `"22:00"`, `"06:00"` | Schedule used for a device whose schedule is not known yet. Whole or half hours. |
| `devices` | `[]` | See below. |
| `exclude` | `[]` | MAC addresses of devices that should not appear in Apple Home. |
| `labels` | | Names of the tiles, for example `{ "pause": "Pause", "schedule": "Schedule", "connected": "Connected" }`. Any language works. |
| `pollInterval` | `15` | Seconds between refreshes. |
| `offlineDelay` | `0` | Seconds a device must be gone before it shows as not connected. |
| `syncAppFlags` | `true` | Keep the "Paused" label in the Linksys app in step. |

### The `devices` list

You only need it for one of these:

- **One switch for a device with two network addresses.** A games console has one
  MAC address for cable and another for Wi-Fi. If only one of them is paused, the
  child can switch to the other. List both and they are paused and resumed together.
- **A device that is not under Parental Controls yet.** The plugin creates the rule
  on the router the first time you pause it. The router allows 14 rules.
- **A different name**, a fixed schedule, or fewer tiles for one device.

```json
"devices": [
  {
    "name": "Living room console",
    "macs": ["AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02"],
    "pauseStart": "21:30",
    "pauseEnd": "07:00"
  },
  {
    "name": "Dad's phone",
    "macs": ["AA:BB:CC:DD:EE:03"],
    "pauseSwitch": false,
    "scheduleSwitch": false
  }
]
```

`pauseStart` and `pauseEnd` are optional. Without them the plugin uses the schedule
it found on the router, and follows it when you change it in the Linksys app.

## Good to know

- **Phones with a private Wi-Fi address.** iPhones, iPads and Android phones can use
  a random MAC address per network. The router then sees a "new" device and the rule
  no longer matches. Turn off *Private Wi-Fi Address* for your home network on any
  device you want to control.
- **Backups.** The remembered schedules are stored in `linksys-velop.json` in the
  Homebridge storage folder, which is part of a normal Homebridge backup.
- **Renaming.** Rename tiles in the Home app. The plugin does not overwrite names
  after it has created a tile.
- **The router password** is stored in the Homebridge `config.json`, like any other
  plugin credential.
- **This is not an official Linksys API.** A firmware update could change it.
- **Restarting the router** takes the network, and Homebridge's connection to it,
  down for a few minutes. The plugin reconnects by itself.

## Checking the connection without Homebridge

The package includes a small command-line tool:

```sh
node cli.js 192.168.1.1 status
node cli.js 192.168.1.1 pause AA:BB:CC:DD:EE:01
node cli.js 192.168.1.1 resume AA:BB:CC:DD:EE:01 22:00 06:00
```

It asks for the admin password without showing it. `resume` without times removes
every restriction from the device.

## Development

```sh
npm test
```

The tests run the plugin against a mock router and need nothing but Node.js.

## Thanks

The JNAP calls were worked out with the help of
[uvjim/pyvelop](https://github.com/uvjim/pyvelop), the library behind the
Home Assistant Linksys Velop integration.

## License

MIT
