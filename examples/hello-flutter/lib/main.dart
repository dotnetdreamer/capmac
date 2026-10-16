// The sample prints on purpose: its lines show in CapMac's console.
// ignore_for_file: avoid_print

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  print('Hello CapMac! Running on ${Platform.operatingSystem}');
  runApp(const HelloApp());
}

class HelloApp extends StatelessWidget {
  const HelloApp({super.key});

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFF3A7AFE);
    return MaterialApp(
      title: 'Hello Flutter',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: seed, brightness: Brightness.light),
      darkTheme: ThemeData(colorSchemeSeed: seed, brightness: Brightness.dark),
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _count = 0;
  String _echo = 'Typing on your PC’s keyboard types here.';
  final _note = TextEditingController();

  @override
  void initState() {
    super.initState();
    // The count survives restarts: a plugin (shared_preferences) keeps it.
    SharedPreferences.getInstance().then((prefs) {
      if (mounted) setState(() => _count = prefs.getInt('count') ?? 0);
    });
  }

  Future<void> _tap() async {
    setState(() => _count += 1);
    print('Counter: $_count');
    if (_count % 5 == 0) debugPrint('That is a lot of taps ($_count)');
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt('count', _count);
  }

  void _send(String text) {
    if (text.isEmpty) return;
    print('Note: $text');
    setState(() => _echo = 'Logged “$text”');
    _note.clear();
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final media = MediaQuery.of(context);
    final mode = kReleaseMode ? 'release' : kProfileMode ? 'profile' : 'debug';
    final device = <String, String>{
      'Platform': _platformName(),
      'OS': Platform.operatingSystemVersion,
      'Build': mode,
      'Screen': '${media.size.width.round()} × ${media.size.height.round()} pt @${media.devicePixelRatio.toStringAsFixed(0)}x',
      'Dart': Platform.version.split(' ').first,
    };
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
              children: [
                Text('Hello from Windows 👋', style: theme.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Text('A Flutter app for iPhone, Mac and Windows, edited on a PC.', style: theme.textTheme.bodyLarge?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                _Section(
                  title: 'Device',
                  child: Column(
                    children: [
                      for (final entry in device.entries)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 3),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              SizedBox(width: 84, child: Text(entry.key, style: TextStyle(color: theme.colorScheme.onSurfaceVariant))),
                              Expanded(child: Text(entry.value)),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
                _Section(
                  title: 'Counter',
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: FilledButton(
                      key: const Key('counter'),
                      onPressed: _tap,
                      child: Text('Tapped $_count time${_count == 1 ? '' : 's'}'),
                    ),
                  ),
                ),
                _Section(
                  title: 'Note',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      TextField(
                        key: const Key('note'),
                        controller: _note,
                        textInputAction: TextInputAction.send,
                        decoration: const InputDecoration(hintText: 'Type something, then Return', border: OutlineInputBorder()),
                        onSubmitted: _send,
                      ),
                      const SizedBox(height: 8),
                      Text(_echo, style: TextStyle(color: theme.colorScheme.onSurfaceVariant)),
                    ],
                  ),
                ),
                _Section(
                  title: 'List',
                  child: Column(
                    children: [
                      for (var i = 1; i <= 40; i++)
                        ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          leading: CircleAvatar(radius: 14, child: Text('$i', style: const TextStyle(fontSize: 12))),
                          title: Text('Item $i'),
                        ),
                    ],
                  ),
                ),
                Text('Edit lib/main.dart while capmac dev runs: CapMac hot-reloads it.', style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _platformName() {
    if (Platform.isIOS) return 'iOS';
    if (Platform.isMacOS) return 'macOS';
    if (Platform.isWindows) return 'Windows';
    return Platform.operatingSystem;
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 8),
      elevation: 0,
      color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title.toUpperCase(), style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant, letterSpacing: 0.6)),
            const SizedBox(height: 10),
            child,
          ],
        ),
      ),
    );
  }
}
