/**
 * Hello React Native: the smallest useful app for trying CapMac. One app for
 * iPhone, Mac and Windows, with a native module (AsyncStorage), typing,
 * scrolling and logs. The sample logs on purpose: its lines show in CapMac's
 * console.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Dimensions,
  PixelRatio,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';

console.log(`Hello CapMac! Running on ${Platform.OS}`);

const COUNT_KEY = 'count';

function platformName(): string {
  switch (Platform.OS) {
    case 'ios':
      return Platform.isPad ? 'iPadOS' : 'iOS';
    case 'macos':
      return 'macOS';
    case 'windows':
      return 'Windows';
    default:
      return Platform.OS;
  }
}

function reactNativeVersion(): string {
  const v = Platform.constants?.reactNativeVersion;
  return v ? `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ''}` : 'unknown';
}

function App() {
  const dark = useColorScheme() === 'dark';
  const colors = dark ? DARK : LIGHT;
  const [count, setCount] = useState(0);
  const [note, setNote] = useState('');
  const [echo, setEcho] = useState('Typing on your PC’s keyboard types here.');

  useEffect(() => {
    // The count survives restarts: a native module (AsyncStorage) keeps it.
    AsyncStorage.getItem(COUNT_KEY).then((value) => setCount(Number(value ?? 0) || 0), (err) => console.warn('Could not read the count', err));
  }, []);

  const tap = () => {
    const next = count + 1;
    setCount(next);
    console.log(`Counter: ${next}`);
    if (next % 5 === 0) console.warn(`That is a lot of taps (${next})`);
    AsyncStorage.setItem(COUNT_KEY, String(next)).catch((err) => console.error('Could not save the count', err));
  };

  const send = () => {
    const text = note.trim();
    if (!text) return;
    console.log(`Note: ${text}`);
    setEcho(`Logged “${text}”`);
    setNote('');
  };

  const screen = Dimensions.get('window');
  const device: Array<[string, string]> = [
    ['Platform', `${platformName()} ${Platform.Version ?? ''}`.trim()],
    ['Build', __DEV__ ? 'debug' : 'release'],
    ['Screen', `${Math.round(screen.width)} × ${Math.round(screen.height)} pt @${PixelRatio.get()}x`],
    ['React Native', reactNativeVersion()],
    ['Engine', (globalThis as { HermesInternal?: unknown }).HermesInternal ? 'Hermes' : 'JavaScriptCore'],
  ];

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.column}>
          <Text style={[styles.title, { color: colors.text }]}>Hello from Windows 👋</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>A React Native app for iPhone, Mac and Windows, edited on a PC.</Text>

          <Section title="Device" colors={colors}>
            {device.map(([label, value]) => (
              <View key={label} style={styles.row}>
                <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
                <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
              </View>
            ))}
          </Section>

          <Section title="Counter" colors={colors}>
            <Pressable testID="counter" accessibilityRole="button" onPress={tap} style={({ pressed }) => [styles.button, { backgroundColor: colors.accent, opacity: pressed ? 0.75 : 1 }]}>
              <Text style={styles.buttonText}>{`Tapped ${count} time${count === 1 ? '' : 's'}`}</Text>
            </Pressable>
          </Section>

          <Section title="Note" colors={colors}>
            <TextInput
              testID="note"
              value={note}
              onChangeText={setNote}
              onSubmitEditing={send}
              returnKeyType="send"
              placeholder="Type something, then Return"
              placeholderTextColor={colors.muted}
              style={[styles.input, { color: colors.text, borderColor: colors.border }]}
            />
            <Text style={[styles.echo, { color: colors.muted }]}>{echo}</Text>
          </Section>

          <Section title="List" colors={colors}>
            {Array.from({ length: 40 }, (_, i) => i + 1).map((i) => (
              <View key={i} style={styles.item}>
                <View style={[styles.badge, { backgroundColor: colors.badge }]}>
                  <Text style={[styles.badgeText, { color: colors.accent }]}>{i}</Text>
                </View>
                <Text style={{ color: colors.text }}>{`Item ${i}`}</Text>
              </View>
            ))}
          </Section>

          <Text style={[styles.footer, { color: colors.muted }]}>Edit App.tsx while capmac dev runs: Fast Refresh shows it at once.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Section({ title, colors, children }: { title: string; colors: Palette; children: ReactNode }) {
  return (
    <View style={[styles.section, { backgroundColor: colors.card }]}>
      <Text style={[styles.sectionTitle, { color: colors.muted }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

interface Palette {
  background: string;
  card: string;
  text: string;
  muted: string;
  accent: string;
  badge: string;
  border: string;
}

const LIGHT: Palette = { background: '#F7F8FC', card: '#ECEEF6', text: '#1A1C22', muted: '#5D6170', accent: '#3A7AFE', badge: '#DCE6FF', border: '#C4C8D4' };
const DARK: Palette = { background: '#111318', card: '#1E2129', text: '#E3E4EA', muted: '#A2A6B4', accent: '#7FA5FF', badge: '#26324F', border: '#3A3E4A' };

const styles = StyleSheet.create({
  root: { flex: 1 },
  // iPhones keep the clock and the camera at the top: start below them.
  scroll: { paddingTop: Platform.OS === 'ios' ? 64 : 24, paddingBottom: 32, paddingHorizontal: 20, alignItems: 'center' },
  column: { width: '100%', maxWidth: 560 },
  title: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 16, marginTop: 4 },
  section: { borderRadius: 16, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 16, marginVertical: 8 },
  sectionTitle: { fontSize: 12, letterSpacing: 0.6, marginBottom: 10 },
  row: { flexDirection: 'row', paddingVertical: 3 },
  label: { width: 110 },
  value: { flex: 1 },
  button: { alignSelf: 'flex-start', borderRadius: 20, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: '#FFFFFF', fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 10 : 6, fontSize: 16 },
  echo: { marginTop: 8 },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  footer: { marginTop: 8, fontSize: 14 },
});

export default App;
