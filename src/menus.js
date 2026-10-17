import { Menu } from "electron";
import path from "node:path";

export function buildMenus( browserWindow, openScriptFile, recentFiles, openFileDialog ) {
	const isMac = process.platform === "darwin";

	const recentSubmenu = recentFiles.map( filePath => ( {
		label: path.basename( filePath ),
		click: () => openScriptFile( filePath )
	} ) );

	if ( recentSubmenu.length > 0 ) {
		recentSubmenu.push( { type: "separator" } );
		recentSubmenu.push( {
			label: "Clear Recent",
			click: () => {
				recentFiles.length = 0;
				buildMenus( browserWindow, openScriptFile, recentFiles, openFileDialog );
			}
		} );
	}

	const template = [
		...( isMac ? [ { role: "appMenu" } ] : [] ),
		{ label: "File", submenu: [
			{
				label: "New",
				accelerator: "CmdOrCtrl+N",
				click: () => {
					browserWindow.webContents.send( "newFile" );
				}
			},
			{
				label: "Open",
				accelerator: "CmdOrCtrl+O",
				click: async () => {
					await openFileDialog();
				}
			},
			{
				label: "Open Recent",
				submenu: recentSubmenu.length > 0
					? recentSubmenu
					: [ { label: "No Recent Files", enabled: false } ]
			},
			{ type: "separator" },
			{
				label: "Save",
				accelerator: "CmdOrCtrl+S",
				click: () => {
					browserWindow.webContents.send( "menuSave" );
				}
			},
			{
				label: "Save As...",
				accelerator: "CmdOrCtrl+Shift+S",
				click: () => {
					browserWindow.webContents.send( "menuSaveAs" );
				}
			},
			{ type: "separator" },
			{ role: "quit" }
		] },
		{ label: "Edit", submenu: [
			{
				label: "Toggle Editor",
				accelerator: "CmdOrCtrl+E",
				click: () => {
					browserWindow.webContents.send( "toggleEditor" );
				}
			},
			{ type: "separator" },
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" }
		] },
		{ label: "Script", submenu: [
			{
				label: "Toggle Auto-scroll",
				accelerator: "CmdOrCtrl+Shift+L",
				click: () => {
					browserWindow.webContents.send( "toggleAutoScroll" );
				}
			},
			{ type: "separator" },
			{
				label: "Increase Auto-scroll Speed",
				accelerator: "CmdOrCtrl+]",
				click: () => {
					browserWindow.webContents.send( "menuAdjustAutoScrollSpeed", "up" );
				}
			},
			{
				label: "Decrease Auto-scroll Speed",
				accelerator: "CmdOrCtrl+[",
				click: () => {
					browserWindow.webContents.send( "menuAdjustAutoScrollSpeed", "down" );
				}
			},
			{
				label: "Reset Auto-scroll Speed",
				accelerator: "CmdOrCtrl+\\",
				click: () => {
					browserWindow.webContents.send( "menuAdjustAutoScrollSpeed", "reset" );
				}
			},
			{ type: "separator" },
			{
				label: "Set Auto-scroll Start Here",
				accelerator: "CmdOrCtrl+Shift+K",
				click: () => {
					browserWindow.webContents.send( "menuSetAutoScrollStart" );
				}
			},
			{
				label: "Clear Auto-scroll Start",
				click: () => {
					browserWindow.webContents.send( "menuClearAutoScrollStart" );
				}
			}
		] },
		{ role: "viewMenu" }
	];

	const menu = Menu.buildFromTemplate( template );
	Menu.setApplicationMenu( menu );
}
