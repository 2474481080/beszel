package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 二改：给 systems 加 group 字段（文件夹/分组），前端按组分区展示。
// 空值 = 未分组。文件夹随字段值自然产生，不需要独立的 groups 表。
func init() {
	m.Register(func(app core.App) error {
		systems, err := app.FindCollectionByNameOrId("systems")
		if err != nil {
			return err
		}
		if systems.Fields.GetByName("group") != nil {
			return nil
		}
		systems.Fields.Add(&core.TextField{
			Name: "group",
			Max:  100,
		})
		return app.Save(systems)
	}, func(app core.App) error {
		systems, err := app.FindCollectionByNameOrId("systems")
		if err != nil {
			return err
		}
		systems.Fields.RemoveByName("group")
		return app.Save(systems)
	})
}
