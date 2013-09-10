# encoding: UTF-8
# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# Note that this schema.rb definition is the authoritative source for your
# database schema. If you need to create the application database on another
# system, you should be using db:schema:load, not running all the migrations
# from scratch. The latter is a flawed and unsustainable approach (the more migrations
# you'll amass, the slower it'll run and the greater likelihood for issues).
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema.define(version: 20121014170439) do

  create_table "dashboards", force: true do |t|
    t.string   "name"
    t.datetime "created_at"
    t.datetime "updated_at"
  end

  add_index "dashboards", ["name"], name: "index_dashboards_on_name", unique: true

  create_table "services", force: true do |t|
    t.integer  "dashboard_id"
    t.string   "name",                                             null: false
    t.string   "host",                                             null: false
    t.boolean  "ping",                             default: true
    t.integer  "ping_threshold",                   default: 500
    t.integer  "ping_last"
    t.boolean  "http",                             default: true
    t.boolean  "https",                            default: false
    t.string   "http_path",                        default: "",    null: false
    t.boolean  "http_path_last",                   default: false
    t.boolean  "https_path_last",                  default: false
    t.string   "http_xquery"
    t.boolean  "http_xquery_last",                 default: false
    t.boolean  "http_preview",                     default: true
    t.binary   "http_screenshot",  limit: 1048576
    t.datetime "checked_at"
    t.datetime "created_at"
    t.datetime "updated_at"
  end

end
