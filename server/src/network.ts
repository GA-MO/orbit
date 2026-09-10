const LOOPBACK = '127.0.0.1'
const EVERY_INTERFACE = '0.0.0.0'
const LAN_ENABLED = '1'

export const LAN_OPEN = process.env.ORBIT_LAN === LAN_ENABLED

export const BIND_HOST = LAN_OPEN ? EVERY_INTERFACE : LOOPBACK
