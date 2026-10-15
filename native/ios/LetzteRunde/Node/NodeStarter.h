#ifndef NodeStarter_h
#define NodeStarter_h

/// Startet Node (nodejs-mobile) mit dem angegebenen Skript. Blockiert, solange Node läuft –
/// deshalb nur aus einem eigenen Thread aufrufen. Darf je Prozess nur einmal laufen.
int kr_node_start(const char *script);

#endif
