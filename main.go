package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	files := &FileService{}

	app := application.New(application.Options{
		Name:        "monoSpace",
		Description: "A distraction-free Markdown writer with vim motions",
		Services: []application.Service{
			application.NewService(files),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
	})
	files.app = app

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "monoSpace",
		Width:            1000,
		Height:           720,
		MinWidth:         480,
		MinHeight:        320,
		Frameless:        true,
		BackgroundColour: application.NewRGB(24, 24, 22),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
