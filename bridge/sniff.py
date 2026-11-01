import serial, time
s = serial.Serial('COM3', 115200, timeout=0.3)
s.reset_input_buffer()
t0 = time.time()
buf = b''
while time.time() - t0 < 3.0:
    buf += s.read(4096)
s.close()
print('BYTES', len(buf))
print('HEAD', repr(buf[:200]))
