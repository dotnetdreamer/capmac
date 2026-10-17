import 'package:flutter_test/flutter_test.dart';
import 'package:hello_flutter/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('the counter counts taps', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const HelloApp());
    await tester.pumpAndSettle();
    expect(find.text('Tapped 0 times'), findsOneWidget);
    await tester.tap(find.text('Tapped 0 times'));
    await tester.pump();
    expect(find.text('Tapped 1 time'), findsOneWidget);
  });
}
